import {
  ComputeBudgetProgram,
  PublicKey,
  type Connection,
} from "@solana/web3.js";
import { getDelegationStatus } from "./connection";
import { DELEGATION_PROGRAM_ID } from "./constants";
import {
  bootstrapIxs,
  delegateCommentPageIx,
  delegateForumIx,
  delegatePostPageIx,
  delegateTreasuryIx,
  type ForumKeys,
} from "./ixs";
import { commentPagePda, forumPda, postPagePda, treasuryPda } from "./pda";
import { sendForumTransaction, type ForumWallet } from "./send";

const DLP = new PublicKey(DELEGATION_PROGRAM_ID);

/**
 * First-holder setup on **L1 only** (not Magic Router), in **one atomic
 * transaction**: initialize + all four delegates.
 *
 * If any instruction fails, Solana rolls the whole tx back — including the
 * rent for Forum / Treasury / page accounts — so you only lose the tiny
 * failed-tx fee (if the failed tx lands), never the ~0.1 SOL rent.
 *
 * Retry path: if a previous broken multi-tx flow already paid rent, we skip
 * initialize and only send the remaining delegate ixs (still one tx).
 */
export async function bootstrapForum(opts: {
  /** Base-layer Solana connection (`/api/rpc` / wallet adapter). */
  connection: Connection;
  keys: ForumKeys;
  wallet: ForumWallet;
  validator: PublicKey;
  routerUrl?: string;
}): Promise<{ mode: "full" | "delegate-only" | "noop" }> {
  const { connection, keys, wallet, validator } = opts;
  const forum = forumPda(keys.programId, keys.mint);
  const treasury = treasuryPda(keys.programId, keys.mint);
  const post0 = postPagePda(keys.programId, forum, 0);
  const comment0 = commentPagePda(keys.programId, forum, 0);

  const forumInfo = await connection.getAccountInfo(forum, "confirmed");
  const initialized = Boolean(forumInfo?.data?.length);

  /**
   * Prefer Magic Router `getDelegationStatus`; fall back to L1 owner == DLP
   * (after a successful delegate, base-layer owner is the Delegation Program).
   */
  async function isDelegated(account: PublicKey, infoOwner?: PublicKey): Promise<boolean> {
    if (infoOwner?.equals(DLP)) return true;
    if (!opts.routerUrl) return false;
    try {
      const st = await getDelegationStatus(opts.routerUrl, account);
      return st.isDelegated;
    } catch {
      return false;
    }
  }

  if (!initialized) {
    // Fresh open: one signature, all-or-nothing for rent + delegation.
    await sendForumTransaction({
      connection,
      routerUrl: "",
      wallet,
      instructions: [
        ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }),
        ...bootstrapIxs(keys, wallet.publicKey, validator),
      ],
    });
    const after = await connection.getAccountInfo(forum, "confirmed");
    if (!after?.data?.length) {
      throw new Error(
        "Forum open did not land. Nothing was created (rent was not kept) — try again."
      );
    }
    return { mode: "full" };
  }

  // Resume after a legacy partial open: only undelegated accounts.
  const pending = [];
  const steps: Array<{
    label: string;
    account: PublicKey;
    ix: ReturnType<typeof delegateForumIx>;
  }> = [
    {
      label: "forum",
      account: forum,
      ix: delegateForumIx(keys, wallet.publicKey, validator),
    },
    {
      label: "treasury",
      account: treasury,
      ix: delegateTreasuryIx(keys, wallet.publicKey, validator),
    },
    {
      label: "posts-0",
      account: post0,
      ix: delegatePostPageIx(keys, wallet.publicKey, 0, validator),
    },
    {
      label: "comments-0",
      account: comment0,
      ix: delegateCommentPageIx(keys, wallet.publicKey, 0, validator),
    },
  ];

  for (const step of steps) {
    const info = await connection.getAccountInfo(step.account, "confirmed");
    if (!info) {
      throw new Error(
        `Forum account "${step.label}" is missing. Cannot finish setup — contact support.`
      );
    }
    if (await isDelegated(step.account, info.owner)) continue;
    pending.push(step.ix);
  }

  if (pending.length === 0) return { mode: "noop" };

  await sendForumTransaction({
    connection,
    routerUrl: "",
    wallet,
    instructions: [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }),
      ...pending,
    ],
  });
  return { mode: "delegate-only" };
}
