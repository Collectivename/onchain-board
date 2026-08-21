import {
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  type AccountMeta,
} from "@solana/web3.js";
import { IX, concatBytes, encodeString, encodeU32, encodeU64 } from "./coder";
import {
  DELEGATION_PROGRAM_ID,
  MAGIC_CONTEXT_ID,
  MAGIC_PROGRAM_ID,
} from "./constants";
import {
  associatedTokenAddress,
  commentPagePda,
  delegateBufferPda,
  delegationMetadataPda,
  delegationRecordPda,
  forumPda,
  magicFeeVaultPda,
  postPagePda,
  treasuryPda,
} from "./pda";

function meta(pubkey: PublicKey, isSigner: boolean, isWritable: boolean): AccountMeta {
  return { pubkey, isSigner, isWritable };
}

function holderAccounts(
  author: PublicKey,
  mint: PublicKey,
  tokenProgram: PublicKey
): AccountMeta[] {
  return [
    meta(author, true, true),
    meta(mint, false, false),
    meta(associatedTokenAddress(mint, author, tokenProgram), false, false),
    meta(tokenProgram, false, false),
  ];
}

/**
 * MagicBlock `#[delegate]` (ephemeral-rollups-sdk 0.16) expands the `del`
 * account in-place as:
 *   buffer, delegation_record, delegation_metadata, <del account>, …
 * then appends owner_program, delegation_program, system_program after all
 * user fields. Putting the PDA *before* the buffer triplet makes Anchor try
 * to deserialize an empty buffer as Forum/Treasury → AccountNotInitialized (0xbc4).
 *
 * See: attribute-delegate-0.16.2/src/lib.rs (buffer fields pushed before the del field).
 * Docs: https://docs.magicblock.gg/pages/ephemeral-rollups-ers/how-to-guide/anchor
 */
function delegateBufferTriplet(
  delegated: PublicKey,
  ownerProgram: PublicKey
): AccountMeta[] {
  return [
    meta(delegateBufferPda(delegated, ownerProgram), false, true),
    meta(delegationRecordPda(delegated), false, true),
    meta(delegationMetadataPda(delegated), false, true),
  ];
}

function delegateProgramTail(ownerProgram: PublicKey): AccountMeta[] {
  return [
    meta(ownerProgram, false, false),
    meta(new PublicKey(DELEGATION_PROGRAM_ID), false, false),
    meta(SystemProgram.programId, false, false),
  ];
}

export interface ForumKeys {
  programId: PublicKey;
  mint: PublicKey;
  tokenProgram: PublicKey;
}

export function initializeIx(keys: ForumKeys, author: PublicKey): TransactionInstruction {
  const forum = forumPda(keys.programId, keys.mint);
  const treasury = treasuryPda(keys.programId, keys.mint);
  return new TransactionInstruction({
    programId: keys.programId,
    data: IX.initialize,
    keys: [
      ...holderAccounts(author, keys.mint, keys.tokenProgram),
      meta(forum, false, true),
      meta(treasury, false, true),
      meta(postPagePda(keys.programId, forum, 0), false, true),
      meta(commentPagePda(keys.programId, forum, 0), false, true),
      meta(SystemProgram.programId, false, false),
    ],
  });
}

function validatorRemaining(validator?: PublicKey): AccountMeta[] {
  return validator ? [meta(validator, false, false)] : [];
}

export function delegateForumIx(
  keys: ForumKeys,
  payer: PublicKey,
  validator?: PublicKey
): TransactionInstruction {
  const forum = forumPda(keys.programId, keys.mint);
  return new TransactionInstruction({
    programId: keys.programId,
    data: IX.delegateForum,
    keys: [
      meta(payer, true, true),
      meta(keys.mint, false, false),
      ...delegateBufferTriplet(forum, keys.programId),
      meta(forum, false, true),
      ...delegateProgramTail(keys.programId),
      ...validatorRemaining(validator),
    ],
  });
}

export function delegateTreasuryIx(
  keys: ForumKeys,
  payer: PublicKey,
  validator?: PublicKey
): TransactionInstruction {
  const treasury = treasuryPda(keys.programId, keys.mint);
  return new TransactionInstruction({
    programId: keys.programId,
    data: IX.delegateTreasury,
    keys: [
      meta(payer, true, true),
      meta(keys.mint, false, false),
      ...delegateBufferTriplet(treasury, keys.programId),
      meta(treasury, false, true),
      ...delegateProgramTail(keys.programId),
      ...validatorRemaining(validator),
    ],
  });
}

export function delegatePostPageIx(
  keys: ForumKeys,
  payer: PublicKey,
  pageIndex: number,
  validator?: PublicKey
): TransactionInstruction {
  const forum = forumPda(keys.programId, keys.mint);
  const page = postPagePda(keys.programId, forum, pageIndex);
  return new TransactionInstruction({
    programId: keys.programId,
    data: concatBytes(IX.delegatePostPage, encodeU32(pageIndex)),
    keys: [
      meta(payer, true, true),
      meta(keys.mint, false, false),
      meta(forum, false, false),
      ...delegateBufferTriplet(page, keys.programId),
      meta(page, false, true),
      ...delegateProgramTail(keys.programId),
      ...validatorRemaining(validator),
    ],
  });
}

export function delegateCommentPageIx(
  keys: ForumKeys,
  payer: PublicKey,
  pageIndex: number,
  validator?: PublicKey
): TransactionInstruction {
  const forum = forumPda(keys.programId, keys.mint);
  const page = commentPagePda(keys.programId, forum, pageIndex);
  return new TransactionInstruction({
    programId: keys.programId,
    data: concatBytes(IX.delegateCommentPage, encodeU32(pageIndex)),
    keys: [
      meta(payer, true, true),
      meta(keys.mint, false, false),
      meta(forum, false, false),
      ...delegateBufferTriplet(page, keys.programId),
      meta(page, false, true),
      ...delegateProgramTail(keys.programId),
      ...validatorRemaining(validator),
    ],
  });
}

/** First-holder setup: init + delegate Forum, Treasury, and page 0s. */
export function bootstrapIxs(
  keys: ForumKeys,
  author: PublicKey,
  validator?: PublicKey
): TransactionInstruction[] {
  return [
    initializeIx(keys, author),
    delegateForumIx(keys, author, validator),
    delegateTreasuryIx(keys, author, validator),
    delegatePostPageIx(keys, author, 0, validator),
    delegateCommentPageIx(keys, author, 0, validator),
  ];
}

export function openPostPageIx(
  keys: ForumKeys,
  author: PublicKey,
  pageIndex: number
): TransactionInstruction {
  const forum = forumPda(keys.programId, keys.mint);
  return new TransactionInstruction({
    programId: keys.programId,
    data: concatBytes(IX.openPostPage, encodeU32(pageIndex)),
    keys: [
      ...holderAccounts(author, keys.mint, keys.tokenProgram),
      meta(forum, false, false),
      meta(postPagePda(keys.programId, forum, pageIndex), false, true),
      meta(SystemProgram.programId, false, false),
    ],
  });
}

export function openCommentPageIx(
  keys: ForumKeys,
  author: PublicKey,
  pageIndex: number
): TransactionInstruction {
  const forum = forumPda(keys.programId, keys.mint);
  return new TransactionInstruction({
    programId: keys.programId,
    data: concatBytes(IX.openCommentPage, encodeU32(pageIndex)),
    keys: [
      ...holderAccounts(author, keys.mint, keys.tokenProgram),
      meta(forum, false, false),
      meta(commentPagePda(keys.programId, forum, pageIndex), false, true),
      meta(SystemProgram.programId, false, false),
    ],
  });
}

export function createPostIx(
  keys: ForumKeys,
  author: PublicKey,
  title: string,
  arweaveId: string,
  pageIndex: number
): TransactionInstruction {
  const forum = forumPda(keys.programId, keys.mint);
  return new TransactionInstruction({
    programId: keys.programId,
    data: concatBytes(IX.createPost, encodeString(title), encodeString(arweaveId)),
    keys: [
      meta(author, true, false),
      meta(keys.mint, false, false),
      meta(associatedTokenAddress(keys.mint, author, keys.tokenProgram), false, false),
      meta(keys.tokenProgram, false, false),
      meta(forum, false, true),
      meta(postPagePda(keys.programId, forum, pageIndex), false, true),
    ],
  });
}

export function createCommentIx(
  keys: ForumKeys,
  author: PublicKey,
  postId: number,
  parentCommentId: number,
  arweaveId: string,
  postPageIndex: number,
  commentPageIndex: number
): TransactionInstruction {
  const forum = forumPda(keys.programId, keys.mint);
  return new TransactionInstruction({
    programId: keys.programId,
    data: concatBytes(
      IX.createComment,
      encodeU64(postId),
      encodeU64(parentCommentId),
      encodeString(arweaveId)
    ),
    keys: [
      meta(author, true, false),
      meta(keys.mint, false, false),
      meta(associatedTokenAddress(keys.mint, author, keys.tokenProgram), false, false),
      meta(keys.tokenProgram, false, false),
      meta(forum, false, true),
      meta(postPagePda(keys.programId, forum, postPageIndex), false, true),
      meta(commentPagePda(keys.programId, forum, commentPageIndex), false, true),
    ],
  });
}

export function maybeCommitIx(
  keys: ForumKeys,
  caller: PublicKey,
  validator: PublicKey,
  extraPages: PublicKey[] = []
): TransactionInstruction {
  const forum = forumPda(keys.programId, keys.mint);
  const treasury = treasuryPda(keys.programId, keys.mint);
  return new TransactionInstruction({
    programId: keys.programId,
    data: IX.maybeCommit,
    keys: [
      meta(caller, true, false),
      meta(forum, false, true),
      meta(treasury, false, true),
      meta(magicFeeVaultPda(validator), false, true),
      meta(new PublicKey(MAGIC_CONTEXT_ID), false, true),
      meta(new PublicKey(MAGIC_PROGRAM_ID), false, false),
      ...extraPages.map((p) => meta(p, false, true)),
    ],
  });
}

/** System transfer to the Treasury PDA. Any wallet can fund commits this way. */
export function fundTreasuryIx(
  from: PublicKey,
  treasury: PublicKey,
  lamports: number
): TransactionInstruction {
  return SystemProgram.transfer({ fromPubkey: from, toPubkey: treasury, lamports });
}
