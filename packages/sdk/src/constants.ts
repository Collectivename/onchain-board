/** Keep in sync with forum/programs/forum/src/state.rs */

export const POSTS_PER_PAGE = 32;
export const COMMENTS_PER_PAGE = 32;
export const TITLE_MAX = 96;
export const ARWEAVE_ID_LEN = 43;
export const COMMIT_COOLDOWN_SECS = 6 * 60 * 60;

export const SEED_FORUM = Buffer.from("forum");
export const SEED_TREASURY = Buffer.from("treasury");
export const SEED_POSTS = Buffer.from("posts");
export const SEED_COMMENTS = Buffer.from("comments");
export const SEED_VALIDATOR = Buffer.from("validator");

export const ATA_PROGRAM_ID = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
export const TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const TOKEN_2022_PROGRAM_ID = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
export const DELEGATION_PROGRAM_ID = "DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh";
export const MAGIC_PROGRAM_ID = "Magic11111111111111111111111111111111111111";
export const MAGIC_CONTEXT_ID = "MagicContext1111111111111111111111111111111";
export const SYSTEM_PROGRAM_ID = "11111111111111111111111111111111";
export const SEED_DELEGATION_RECORD = Buffer.from("delegation");
export const SEED_DELEGATION_METADATA = Buffer.from("delegation-metadata");
export const SEED_DELEGATE_BUFFER = Buffer.from("buffer");
export const SEED_MAGIC_FEE_VAULT = Buffer.from("magic-fee-vault");

/** MagicBlock public ER validators (same pubkeys on devnet and mainnet). */
export const ER_VALIDATORS = {
  asia: "MAS1Dt9qreoRMQ14YQuhg8UTZMMzDdKhmkZMECCzk57",
  eu: "MEUGGrYPxKk17hCr7wpT6s8dtNokZj5U2L57vjYMS8e",
  us: "MUS3hc9TCw4cGC12vHNoYcCGzJG1txjgQLZWVoeNHNd",
} as const;

export const DEFAULT_ROUTER = {
  devnet: "https://devnet-router.magicblock.app",
  mainnet: "https://router.magicblock.app",
} as const;

export const ARWEAVE_ID_RE = /^[A-Za-z0-9_-]{43}$/;
export const MAX_FREE_UPLOAD_BYTES = 100 * 1024;
export const INDEX_CACHE_TTL_MS = 30_000;
export const BODY_MISS_TTL_MS = 60_000;

/**
 * Approximate SOL the first holder must pay to `initialize` (Forum + Treasury +
 * two ~10 KiB pages). Exact rent floats with the network; each page alone is
 * ~0.0476 SOL. Includes a small buffer for fees + follow-up delegate txs.
 */
export const BOOTSTRAP_MIN_SOL = 0.12;
