import { PublicKey } from "@solana/web3.js";

function hexBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/** Anchor `global:<name>` discriminators (sha256, first 8 bytes). */
export const IX = {
  initialize: hexBytes("afaf6d1f0d989bed"),
  delegateForum: hexBytes("ca984dafe2b6e426"),
  delegateTreasury: hexBytes("dce62d385cdfa2a9"),
  delegatePostPage: hexBytes("763649c47a237358"),
  delegateCommentPage: hexBytes("99adc7b41b9bd933"),
  openPostPage: hexBytes("53a266941d6a87ee"),
  openCommentPage: hexBytes("cec2023ec3139ae3"),
  createPost: hexBytes("7b5cb81de7180fca"),
  createComment: hexBytes("ece80bb446ce4991"),
  maybeCommit: hexBytes("da473b6c816f4d2f"),
} as const;

/** Account bytes from web3.js — Buffer in Node, Uint8Array in the browser. */
export type AccountBytes = Uint8Array;

/**
 * Normalize RPC account data for decoding. Browser builds often lack Buffer
 * methods like `readBigUInt64LE` even when `Buffer.from` exists.
 */
export function asBytes(data: Uint8Array | Buffer | number[] | string): Uint8Array {
  if (typeof data === "string") {
    // base64 from some RPC shapes
    const bin = atob(data);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  if (data instanceof Uint8Array) return data;
  return Uint8Array.from(data);
}

function view(data: AccountBytes): DataView {
  return new DataView(data.buffer, data.byteOffset, data.byteLength);
}

/** Allocate a fresh byte buffer (browser-safe; no Node Buffer methods). */
function alloc(n: number): Uint8Array {
  return new Uint8Array(n);
}

export function encodeString(s: string): Uint8Array {
  const body = new TextEncoder().encode(s);
  const out = alloc(4 + body.length);
  new DataView(out.buffer).setUint32(0, body.length, true);
  out.set(body, 4);
  return out;
}

export function encodeU64(n: bigint | number): Uint8Array {
  const out = alloc(8);
  new DataView(out.buffer).setBigUint64(0, BigInt(n), true);
  return out;
}

export function encodeU32(n: number): Uint8Array {
  const out = alloc(4);
  new DataView(out.buffer).setUint32(0, n >>> 0, true);
  return out;
}

/** Concatenate instruction data chunks without relying on Node Buffer.concat. */
export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  let len = 0;
  for (const p of parts) len += p.length;
  const out = alloc(len);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export function readPubkey(data: AccountBytes, offset: number): { key: string; next: number } {
  return {
    key: new PublicKey(data.subarray(offset, offset + 32)).toBase58(),
    next: offset + 32,
  };
}

export function readU64(data: AccountBytes, offset: number): { n: bigint; next: number } {
  return { n: view(data).getBigUint64(offset, true), next: offset + 8 };
}

export function readI64(data: AccountBytes, offset: number): { n: bigint; next: number } {
  return { n: view(data).getBigInt64(offset, true), next: offset + 8 };
}

export function readU32(data: AccountBytes, offset: number): { n: number; next: number } {
  return { n: view(data).getUint32(offset, true), next: offset + 4 };
}

export function readU8(data: AccountBytes, offset: number): { n: number; next: number } {
  return { n: data[offset] ?? 0, next: offset + 1 };
}

export function readBool(data: AccountBytes, offset: number): { v: boolean; next: number } {
  return { v: (data[offset] ?? 0) !== 0, next: offset + 1 };
}

export function readFixedUtf8(
  data: AccountBytes,
  offset: number,
  max: number,
  len: number
): { s: string; next: number } {
  const n = Math.min(Math.max(0, len), max);
  const slice = data.subarray(offset, offset + n);
  return {
    s: new TextDecoder().decode(slice),
    next: offset + max,
  };
}
