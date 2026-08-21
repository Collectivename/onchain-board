import { PublicKey } from "@solana/web3.js";
import {
  ARWEAVE_ID_LEN,
  COMMENTS_PER_PAGE,
  POSTS_PER_PAGE,
  TITLE_MAX,
} from "./constants";
import {
  asBytes,
  readBool,
  readI64,
  readPubkey,
  readU32,
  readU64,
  readU8,
  type AccountBytes,
} from "./coder";

export interface ForumAccount {
  mint: string;
  tokenProgram: string;
  postCount: number;
  commentCount: number;
  postPageCount: number;
  commentPageCount: number;
  lastCommitUnix: number;
  lastCommittedPosts: number;
  lastCommittedComments: number;
  paused: boolean;
  bump: number;
}

export interface PostRecord {
  id: number;
  author: string;
  createdUnix: number;
  commentCount: number;
  title: string;
  arweaveId: string;
}

export interface CommentRecord {
  id: number;
  postId: number;
  parentCommentId: number;
  author: string;
  createdUnix: number;
  arweaveId: string;
}

export function decodeForum(raw: AccountBytes | Buffer): ForumAccount {
  const data = asBytes(raw);
  let o = 8;
  const mint = readPubkey(data, o);
  o = mint.next;
  const tokenProgram = readPubkey(data, o);
  o = tokenProgram.next;
  const postCount = readU64(data, o);
  o = postCount.next;
  const commentCount = readU64(data, o);
  o = commentCount.next;
  const postPageCount = readU32(data, o);
  o = postPageCount.next;
  const commentPageCount = readU32(data, o);
  o = commentPageCount.next;
  const lastCommitUnix = readI64(data, o);
  o = lastCommitUnix.next;
  const lastCommittedPosts = readU64(data, o);
  o = lastCommittedPosts.next;
  const lastCommittedComments = readU64(data, o);
  o = lastCommittedComments.next;
  const paused = readBool(data, o);
  o = paused.next;
  const bump = readU8(data, o);
  return {
    mint: mint.key,
    tokenProgram: tokenProgram.key,
    postCount: Number(postCount.n),
    commentCount: Number(commentCount.n),
    postPageCount: postPageCount.n,
    commentPageCount: commentPageCount.n,
    lastCommitUnix: Number(lastCommitUnix.n),
    lastCommittedPosts: Number(lastCommittedPosts.n),
    lastCommittedComments: Number(lastCommittedComments.n),
    paused: paused.v,
    bump: bump.n,
  };
}

/**
 * Zero-copy PostSlot layout (repr(C)):
 * occupied u8, title_len u8, _pad0[6], id u64, author, created i64,
 * comment_count u64, title[96], arweave_id[43], _pad1[5]
 */
const POST_SLOT_SIZE = 8 + 8 + 32 + 8 + 8 + TITLE_MAX + ARWEAVE_ID_LEN + 5;
const utf8 = new TextDecoder();

function decodePostSlot(
  data: AccountBytes,
  offset: number
): { slot: PostRecord | null; next: number } {
  const occupied = data[offset] !== 0;
  const titleLen = data[offset + 1] ?? 0;
  let o = offset + 8; // skip occupied, title_len, pad6
  const id = readU64(data, o);
  o = id.next;
  const author = readPubkey(data, o);
  o = author.next;
  const created = readI64(data, o);
  o = created.next;
  const comments = readU64(data, o);
  o = comments.next;
  const title = utf8.decode(data.subarray(o, o + Math.min(titleLen, TITLE_MAX)));
  o += TITLE_MAX;
  const ar = utf8.decode(data.subarray(o, o + ARWEAVE_ID_LEN));
  o += ARWEAVE_ID_LEN + 5; // arweave + pad1
  if (!occupied) return { slot: null, next: offset + POST_SLOT_SIZE };
  return {
    slot: {
      id: Number(id.n),
      author: author.key,
      createdUnix: Number(created.n),
      commentCount: Number(comments.n),
      title,
      arweaveId: ar.replace(/\0+$/, ""),
    },
    next: offset + POST_SLOT_SIZE,
  };
}

export function decodePostPage(raw: AccountBytes | Buffer): PostRecord[] {
  const data = asBytes(raw);
  // disc(8) + forum(32) + page_index(4) + filled(4) + bump(1) + pad(7)
  let o = 8 + 32 + 4 + 4 + 1 + 7;
  const out: PostRecord[] = [];
  for (let i = 0; i < POSTS_PER_PAGE; i++) {
    const r = decodePostSlot(data, o);
    o = r.next;
    if (r.slot) out.push(r.slot);
  }
  return out;
}

/**
 * Zero-copy CommentSlot:
 * occupied u8, pad7, id, post_id, parent, author, created, arweave[43], pad5
 */
const COMMENT_SLOT_SIZE = 8 + 8 + 8 + 8 + 32 + 8 + ARWEAVE_ID_LEN + 5;

function decodeCommentSlot(
  data: AccountBytes,
  offset: number
): { slot: CommentRecord | null; next: number } {
  const occupied = data[offset] !== 0;
  let o = offset + 8;
  const id = readU64(data, o);
  o = id.next;
  const postId = readU64(data, o);
  o = postId.next;
  const parent = readU64(data, o);
  o = parent.next;
  const author = readPubkey(data, o);
  o = author.next;
  const created = readI64(data, o);
  o = created.next;
  const ar = utf8.decode(data.subarray(o, o + ARWEAVE_ID_LEN));
  if (!occupied) return { slot: null, next: offset + COMMENT_SLOT_SIZE };
  return {
    slot: {
      id: Number(id.n),
      postId: Number(postId.n),
      parentCommentId: Number(parent.n),
      author: author.key,
      createdUnix: Number(created.n),
      arweaveId: ar.replace(/\0+$/, ""),
    },
    next: offset + COMMENT_SLOT_SIZE,
  };
}

export function decodeCommentPage(raw: AccountBytes | Buffer): CommentRecord[] {
  const data = asBytes(raw);
  let o = 8 + 32 + 4 + 4 + 1 + 7;
  const out: CommentRecord[] = [];
  for (let i = 0; i < COMMENTS_PER_PAGE; i++) {
    const r = decodeCommentSlot(data, o);
    o = r.next;
    if (r.slot) out.push(r.slot);
  }
  return out;
}

export function mintTokenProgram(mintAccountOwner: PublicKey): PublicKey {
  return mintAccountOwner;
}
