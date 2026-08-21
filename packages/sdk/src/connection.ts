import { Connection, PublicKey, type Commitment } from "@solana/web3.js";

export function httpToWs(url: string): string {
  if (url.startsWith("https://")) return `wss://${url.slice("https://".length)}`;
  if (url.startsWith("http://")) return `ws://${url.slice("http://".length)}`;
  return url;
}

export function routerConnection(routerUrl: string, commitment: Commitment = "confirmed"): Connection {
  const http = routerUrl.replace(/\/$/, "");
  return new Connection(http, { commitment, wsEndpoint: httpToWs(http) });
}

export interface DelegationStatus {
  isDelegated: boolean;
  fqdn?: string;
  authority?: string;
}

interface JsonRpcOk<T> {
  result?: T;
  error?: { message?: string; code?: number };
}

async function rpc<T>(url: string, method: string, params: unknown[]): Promise<T> {
  const res = await fetch(url.replace(/\/$/, ""), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(12_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const j = (await res.json()) as JsonRpcOk<T>;
  if (j.error) throw new Error(j.error.message ?? method);
  if (j.result === undefined) throw new Error(`${method}: empty result`);
  return j.result;
}

export async function getDelegationStatus(
  routerUrl: string,
  account: PublicKey
): Promise<DelegationStatus> {
  const raw = await rpc<{
    isDelegated?: boolean;
    fqdn?: string;
    delegationRecord?: { authority?: string };
  }>(routerUrl, "getDelegationStatus", [account.toBase58()]);
  return {
    isDelegated: Boolean(raw.isDelegated),
    fqdn: raw.fqdn?.replace(/\/$/, ""),
    authority: raw.delegationRecord?.authority,
  };
}

export async function getBlockhashForAccounts(
  routerUrl: string,
  accounts: PublicKey[]
): Promise<{ blockhash: string; lastValidBlockHeight: number }> {
  return rpc(routerUrl, "getBlockhashForAccounts", [accounts.map((a) => a.toBase58())]);
}

/** Token account amount (u64 LE at offset 64). */
export function tokenAmount(data: Uint8Array | Buffer): bigint {
  const bytes = data instanceof Uint8Array ? data : Uint8Array.from(data);
  if (bytes.length < 72) return BigInt(0);
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getBigUint64(64, true);
}
