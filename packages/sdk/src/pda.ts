import { PublicKey } from "@solana/web3.js";
import {
  ATA_PROGRAM_ID,
  DELEGATION_PROGRAM_ID,
  SEED_COMMENTS,
  SEED_DELEGATE_BUFFER,
  SEED_DELEGATION_METADATA,
  SEED_DELEGATION_RECORD,
  SEED_FORUM,
  SEED_MAGIC_FEE_VAULT,
  SEED_POSTS,
  SEED_TREASURY,
} from "./constants";

export function forumPda(programId: PublicKey, mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([SEED_FORUM, mint.toBuffer()], programId)[0];
}

export function treasuryPda(programId: PublicKey, mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([SEED_TREASURY, mint.toBuffer()], programId)[0];
}

export function u32le(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n >>> 0, 0);
  return b;
}

export function postPagePda(
  programId: PublicKey,
  forum: PublicKey,
  pageIndex: number
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [SEED_POSTS, forum.toBuffer(), u32le(pageIndex)],
    programId
  )[0];
}

export function commentPagePda(
  programId: PublicKey,
  forum: PublicKey,
  pageIndex: number
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [SEED_COMMENTS, forum.toBuffer(), u32le(pageIndex)],
    programId
  )[0];
}

export function associatedTokenAddress(
  mint: PublicKey,
  owner: PublicKey,
  tokenProgram: PublicKey
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [owner.toBuffer(), tokenProgram.toBuffer(), mint.toBuffer()],
    new PublicKey(ATA_PROGRAM_ID)
  )[0];
}

/** Delegation Program PDA: `["magic-fee-vault", validator]`. MagicBlock's, not ours. */
export function magicFeeVaultPda(validator: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [SEED_MAGIC_FEE_VAULT, validator.toBuffer()],
    new PublicKey(DELEGATION_PROGRAM_ID)
  )[0];
}

export function delegationRecordPda(delegated: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [SEED_DELEGATION_RECORD, delegated.toBuffer()],
    new PublicKey(DELEGATION_PROGRAM_ID)
  )[0];
}

export function delegationMetadataPda(delegated: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [SEED_DELEGATION_METADATA, delegated.toBuffer()],
    new PublicKey(DELEGATION_PROGRAM_ID)
  )[0];
}

/** Buffer PDA is owned by the *owner program*, not the Delegation Program. */
export function delegateBufferPda(delegated: PublicKey, ownerProgram: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [SEED_DELEGATE_BUFFER, delegated.toBuffer()],
    ownerProgram
  )[0];
}
