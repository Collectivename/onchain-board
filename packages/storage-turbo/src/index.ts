import { TurboFactory, ArweaveSigner } from "@ardrive/turbo-sdk";
import type { TurboAuthenticatedClient } from "@ardrive/turbo-sdk";

export const MAX_FREE_UPLOAD_BYTES = 100 * 1024;
export const ARWEAVE_ID_RE = /^[A-Za-z0-9_-]{43}$/;
/** 404s are transient right after Turbo upload — never cache a miss for long. */
export const BODY_MISS_TTL_MS = 4_000;

/**
 * Official Arweave read paths only (SSRF). turbo-gateway.com is Turbo’s own
 * Arweave gateway (data is available there first). arweave.net is L1.
 * https://docs.ar.io/SKILL.md
 */
const TURBO_GATEWAY = "https://turbo-gateway.com";
const ARWEAVE_L1 = "https://arweave.net";
const GATEWAYS = [TURBO_GATEWAY, ARWEAVE_L1] as const;
/** Apex hosts. Gateways 302 the bytes onto a data-node subdomain of the same site. */
const ALLOWED_HOSTS = GATEWAYS.map((base) => new URL(base).host);
const RACE_MS = 2_000;
const FRESH_ATTEMPTS = 4;
const MAX_REDIRECTS = 3;

export type JsonWebKeyLike = Record<string, unknown>;

function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function assertUnderFreeCap(text: string): void {
  const n = byteLength(text);
  if (n > MAX_FREE_UPLOAD_BYTES) {
    throw new Error(
      `Body is ${n} bytes; the free Turbo cap is ${MAX_FREE_UPLOAD_BYTES}. Shorten it.`
    );
  }
}

export async function uploadMarkdown(opts: {
  jwk: JsonWebKeyLike;
  text: string;
  appName?: string;
}): Promise<{ id: string; winc: string }> {
  assertUnderFreeCap(opts.text);
  const turbo: TurboAuthenticatedClient = TurboFactory.authenticated({
    signer: new ArweaveSigner(opts.jwk as unknown as ConstructorParameters<typeof ArweaveSigner>[0]),
  });
  const res = await turbo.upload({
    data: opts.text,
    dataItemOpts: {
      tags: [
        { name: "Content-Type", value: "text/plain; charset=utf-8" },
        { name: "App-Name", value: opts.appName ?? "holder-forum" },
      ],
    },
    signal: AbortSignal.timeout(20_000),
  });
  const winc = res.winc ?? "0";
  if (winc !== "0") {
    throw new Error(`Upload was not free (winc=${winc}). Refusing a paid upload.`);
  }
  if (!ARWEAVE_ID_RE.test(res.id)) {
    throw new Error("Turbo returned an invalid Arweave id.");
  }
  // Do not seed the read cache from this string. Other users must get the
  // bytes from an Arweave gateway. Warm in the background once upload returns.
  void fetchMarkdown(res.id);
  return { id: res.id, winc };
}

/** Confirmed Arweave GETs only. Bounded so a long-lived process cannot grow forever. */
const HIT_CAP = 2_000;
const hitCache = new Map<string, string>();
const missCache = new Map<string, number>();
const inflight = new Map<string, Promise<string | null>>();

function rememberHit(id: string, text: string): void {
  missCache.delete(id);
  if (hitCache.has(id)) {
    hitCache.delete(id);
  } else if (hitCache.size >= HIT_CAP) {
    const oldest = hitCache.keys().next().value;
    if (oldest) hitCache.delete(oldest);
  }
  hitCache.set(id, text);
}

function allowedGateway(url: URL): boolean {
  if (url.protocol !== "https:") return false;
  const host = url.hostname.toLowerCase();
  return ALLOWED_HOSTS.some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
}

/** Stop after the free-upload cap so a random id cannot pull an unbounded file. */
async function readCapped(res: Response, max: number): Promise<string> {
  const declared = Number(res.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > max) {
    throw new Error("body too large");
  }
  if (!res.body) {
    const text = await res.text();
    if (byteLength(text) > max) throw new Error("body too large");
    return text;
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > max) throw new Error("body too large");
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(out);
}

async function getFromGateway(
  base: string,
  id: string,
  signal: AbortSignal
): Promise<string> {
  let url = new URL(`${base.replace(/\/$/, "")}/${id}`);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (!allowedGateway(url)) throw new Error("redirect off gateway");
    const res = await fetch(url, {
      redirect: "manual",
      signal,
      // Never cache 404s in Next’s Data Cache — a miss is not the final body.
      cache: "no-store",
    });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      if (!loc || hop === MAX_REDIRECTS) throw new Error("redirect off gateway");
      url = new URL(loc, url);
      continue;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return readCapped(res, MAX_FREE_UPLOAD_BYTES);
  }
  throw new Error("redirect off gateway");
}

/** First Arweave gateway to return 200 wins. */
async function raceGateways(id: string, ms: number): Promise<string | null> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  try {
    return await Promise.any(GATEWAYS.map((base) => getFromGateway(base, id, ac.signal)));
  } catch {
    return null;
  } finally {
    ac.abort();
    clearTimeout(timer);
  }
}

/**
 * Fetch a body from Arweave by id. Only a successful gateway 200 is stored,
 * and that entry is kept for the life of the process (ids are immutable).
 */
export async function fetchMarkdown(
  id: string,
  opts?: { missTtlMs?: number }
): Promise<string | null> {
  const tx = id.trim();
  if (!ARWEAVE_ID_RE.test(tx)) return null;
  const hit = hitCache.get(tx);
  if (hit !== undefined) return hit;
  const missed = missCache.get(tx);
  if (missed !== undefined && Date.now() - missed < (opts?.missTtlMs ?? BODY_MISS_TTL_MS)) {
    return null;
  }
  const existing = inflight.get(tx);
  if (existing) return existing;

  const pending = (async () => {
    for (let attempt = 0; attempt < FRESH_ATTEMPTS; attempt++) {
      const text = await raceGateways(tx, RACE_MS);
      if (text !== null) {
        rememberHit(tx, text);
        return text;
      }
      if (attempt < FRESH_ATTEMPTS - 1) await sleep(300 * (attempt + 1));
    }
    missCache.set(tx, Date.now());
    return null;
  })().finally(() => inflight.delete(tx));

  inflight.set(tx, pending);
  return pending;
}

export const FORUM_GATEWAYS = GATEWAYS;
