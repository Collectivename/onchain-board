import {
  PublicKey,
  Transaction,
  TransactionInstruction,
  type Connection,
} from "@solana/web3.js";
import { getBlockhashForAccounts } from "./connection";

export interface ForumWallet {
  publicKey: PublicKey;
  signTransaction: (tx: Transaction) => Promise<Transaction>;
  signAllTransactions?: (txs: Transaction[]) => Promise<Transaction[]>;
}

function writableKeys(ixs: TransactionInstruction[]): PublicKey[] {
  const seen = new Set<string>();
  const out: PublicKey[] = [];
  for (const ix of ixs) {
    for (const k of ix.keys) {
      if (!k.isWritable) continue;
      const s = k.pubkey.toBase58();
      if (seen.has(s)) continue;
      seen.add(s);
      out.push(k.pubkey);
    }
  }
  return out;
}

async function confirmHttp(
  connection: Connection,
  signature: string,
  lastValidBlockHeight: number
): Promise<void> {
  for (let i = 0; i < 45; i++) {
    const status = await connection.getSignatureStatuses([signature]);
    const row = status.value[0];
    if (row?.err) {
      throw new Error(`Transaction failed: ${JSON.stringify(row.err)}`);
    }
    if (row?.confirmationStatus === "confirmed" || row?.confirmationStatus === "finalized") {
      return;
    }
    if (lastValidBlockHeight > 0) {
      const height = await connection.getBlockHeight("confirmed").catch(() => 0);
      if (height > lastValidBlockHeight) {
        throw new Error(`Signature ${signature} has expired: block height exceeded`);
      }
    }
    await new Promise((r) => setTimeout(r, 800));
  }
  throw new Error(`Signature ${signature} was not confirmed`);
}

function isStaleBlockhash(err: unknown): boolean {
  const raw = err instanceof Error ? err.message : String(err);
  return /blockhash not found|block height exceeded|expired/i.test(raw);
}

async function latestFromConnection(
  connection: Connection
): Promise<{ blockhash: string; lastValidBlockHeight: number }> {
  return connection.getLatestBlockhash("confirmed");
}

async function latestBlockhash(
  connection: Connection,
  routerUrl: string,
  accounts: PublicKey[]
): Promise<{ blockhash: string; lastValidBlockHeight: number }> {
  // Empty routerUrl = L1-only path (initialize / first delegates).
  if (routerUrl) {
    try {
      if (accounts.length > 0) {
        const r = await getBlockhashForAccounts(routerUrl, accounts);
        if (r.blockhash) {
          return {
            blockhash: r.blockhash,
            lastValidBlockHeight: r.lastValidBlockHeight ?? 0,
          };
        }
      }
    } catch {
      // Router method is best-effort; standard getLatestBlockhash still works.
    }
  }
  return latestFromConnection(connection);
}

export async function sendForumTransaction(opts: {
  connection: Connection;
  routerUrl: string;
  wallet: ForumWallet;
  instructions: TransactionInstruction[];
}): Promise<string> {
  const accounts = writableKeys(opts.instructions);
  let lastErr: unknown;

  // Wallet approval can burn the first blockhash; one refetch+re-sign covers that.
  for (let attempt = 0; attempt < 2; attempt++) {
    const latest = await latestBlockhash(opts.connection, opts.routerUrl, accounts);
    const tx = new Transaction();
    tx.add(...opts.instructions);
    tx.feePayer = opts.wallet.publicKey;
    tx.recentBlockhash = latest.blockhash;

    const signed = await opts.wallet.signTransaction(tx);
    let sig: string;
    try {
      sig = await opts.connection.sendRawTransaction(signed.serialize(), {
        skipPreflight: false,
        preflightCommitment: "confirmed",
      });
    } catch (err) {
      lastErr = err;
      if (!isStaleBlockhash(err) || attempt === 1) break;
      continue;
    }
    // A signature already exists. Poll it. Do not sign a second copy.
    await confirmHttp(opts.connection, sig, latest.lastValidBlockHeight);
    return sig;
  }

  throw lastErr;
}

export async function sendForumTransactions(opts: {
  connection: Connection;
  routerUrl: string;
  wallet: ForumWallet;
  groups: TransactionInstruction[][];
}): Promise<string[]> {
  // Sequential: fresh blockhash + sign + send + confirm per group.
  // Never pre-sign later groups (avoids fee burn on a follow-up that can't
  // succeed until the previous group lands).
  const sigs: string[] = [];
  for (const ixs of opts.groups) {
    if (ixs.length === 0) continue;
    const sig = await sendForumTransaction({
      connection: opts.connection,
      routerUrl: opts.routerUrl,
      wallet: opts.wallet,
      instructions: ixs,
    });
    sigs.push(sig);
  }
  return sigs;
}
