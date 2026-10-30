import { Connection, PublicKey, type AccountInfo, type Commitment } from "@solana/web3.js";
import {
  COMMENTS_PER_PAGE,
  INDEX_CACHE_TTL_MS,
  POSTS_PER_PAGE,
} from "./constants";
import { getDelegationStatus, routerConnection, tokenAmount } from "./connection";
import {
  decodeCommentPage,
  decodeForum,
  decodePostPage,
  type CommentRecord,
  type ForumAccount,
  type PostRecord,
} from "./decode";
import { asBytes } from "./coder";
import { associatedTokenAddress, commentPagePda, forumPda, postPagePda } from "./pda";

export interface ForumIndex {
  forum: ForumAccount;
  posts: PostRecord[];
}

export interface ForumReaderOpts {
  programId: PublicKey;
  mint: PublicKey;
  routerUrl: string;
  /** Optional regional ER HTTP, used only after Router failover via fqdn. */
  cacheTtlMs?: number;
  /** Prefer `processed` for snappy list reads (default). */
  commitment?: Commitment;
}

interface CacheEntry<T> {
  at: number;
  value: T;
}

/**
 * Production reader: Magic Router primary, ER fqdn failover.
 * Prefers one getMultipleAccountsInfo round-trip for the index.
 * Never GPA. Never Collective RPC.
 */
export class ForumReader {
  readonly programId: PublicKey;
  readonly mint: PublicKey;
  readonly routerUrl: string;
  readonly forum: PublicKey;
  private readonly ttl: number;
  private readonly commitment: Commitment;
  private conn: Connection;
  private failover: Connection | null = null;
  private readonly cache = new Map<string, CacheEntry<unknown>>();
  private readonly inflight = new Map<string, Promise<unknown>>();
  private generation = 0;

  constructor(opts: ForumReaderOpts) {
    this.programId = opts.programId;
    this.mint = opts.mint;
    this.routerUrl = opts.routerUrl.replace(/\/$/, "");
    this.forum = forumPda(opts.programId, opts.mint);
    this.ttl = opts.cacheTtlMs ?? INDEX_CACHE_TTL_MS;
    this.commitment = opts.commitment ?? "processed";
    this.conn = routerConnection(this.routerUrl, this.commitment);
  }

  connection(): Connection {
    return this.failover ?? this.conn;
  }

  /** Drop volatile caches but keep long-lived page payloads when soft=true. */
  invalidate(soft = false): void {
    this.generation += 1;
    this.inflight.clear();
    if (!soft) {
      this.cache.clear();
      return;
    }
    this.cache.delete("forum");
    this.cache.delete("index");
  }

  /** Drop post/comment page snapshots so a just-written slot is visible. */
  invalidatePages(): void {
    for (const k of [...this.cache.keys()]) {
      if (k.startsWith("pp:") || k.startsWith("cp:")) this.cache.delete(k);
    }
  }

  /** In-memory hit without a network round-trip (for instant paint). */
  peekIndex(): ForumIndex | null {
    const hit = this.cache.get("index");
    if (!hit) return null;
    return hit.value as ForumIndex;
  }

  private cached<T>(key: string, load: () => Promise<T>): Promise<T> {
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < this.ttl) return Promise.resolve(hit.value as T);
    const pending = this.inflight.get(key);
    if (pending) return pending as Promise<T>;
    const gen = this.generation;
    const p = load()
      .then((value) => {
        if (gen === this.generation) this.cache.set(key, { at: Date.now(), value });
        return value;
      })
      .finally(() => {
        if (this.inflight.get(key) === p) this.inflight.delete(key);
      });
    this.inflight.set(key, p);
    return p;
  }

  private async withFailover<T>(fn: (c: Connection) => Promise<T>): Promise<T> {
    try {
      return await fn(this.connection());
    } catch (first) {
      try {
        const st = await getDelegationStatus(this.routerUrl, this.forum);
        if (st.fqdn && st.fqdn !== this.routerUrl) {
          this.failover = routerConnection(st.fqdn, this.commitment);
          return await fn(this.failover);
        }
      } catch {
        // keep original error
      }
      throw first;
    }
  }

  private decodeForumAcc(acc: AccountInfo<Buffer> | null): ForumAccount | null {
    if (!acc?.data) return null;
    return decodeForum(asBytes(acc.data as Uint8Array));
  }

  async getForum(): Promise<ForumAccount | null> {
    return this.cached("forum", async () => this.readForum(this.commitment));
  }

  /** Uncached read. Page selection uses `confirmed` so a stale `processed` view cannot target a full page. */
  async readForum(commitment: Commitment = "confirmed"): Promise<ForumAccount | null> {
    const acc = await this.withFailover((c) => c.getAccountInfo(this.forum, commitment));
    return this.decodeForumAcc(acc);
  }

  async getPostPage(pageIndex: number): Promise<PostRecord[]> {
    const addr = postPagePda(this.programId, this.forum, pageIndex);
    return this.cached(`pp:${pageIndex}`, async () => {
      const acc = await this.withFailover((c) => c.getAccountInfo(addr, this.commitment));
      if (!acc?.data) return [];
      return decodePostPage(asBytes(acc.data as Uint8Array));
    });
  }

  async getCommentPage(pageIndex: number): Promise<CommentRecord[]> {
    const addr = commentPagePda(this.programId, this.forum, pageIndex);
    return this.cached(`cp:${pageIndex}`, async () => {
      const acc = await this.withFailover((c) => c.getAccountInfo(addr, this.commitment));
      if (!acc?.data) return [];
      return decodeCommentPage(asBytes(acc.data as Uint8Array));
    });
  }

  /**
   * Fast path: one getMultipleAccountsInfo for forum + recent post pages
   * (avoids forum-then-pages waterfall).
   */
  async loadIndex(recentPostPages = 6): Promise<ForumIndex | null> {
    return this.cached("index", async () => {
      // Speculative page 0 always exists after initialize; fetch forum + last pages together.
      // We may over-fetch one empty page before we know postPageCount — still 1 RTT.
      const speculative = Math.max(1, recentPostPages);
      const addrs: PublicKey[] = [this.forum];
      for (let i = 0; i < speculative; i++) {
        addrs.push(postPagePda(this.programId, this.forum, i));
      }

      let infos = await this.withFailover((c) =>
        c.getMultipleAccountsInfo(addrs, this.commitment)
      );
      const forum = this.decodeForumAcc(infos[0] ?? null);
      if (!forum) return null;

      this.cache.set("forum", { at: Date.now(), value: forum });

      const last = Math.max(
        0,
        Math.max(forum.postPageCount, Math.ceil(forum.postCount / POSTS_PER_PAGE) || 1) - 1
      );
      // Pull enough recent pages for client-side feed pagination (cap keeps RPC light).
      const window = Math.min(Math.max(recentPostPages, 1), 12);
      const start = Math.max(0, last - (window - 1));

      // If the real window isn't [0 .. speculative), refetch only the needed pages in one shot.
      const needExtra = start > 0 || last >= speculative;
      let pageInfos = infos.slice(1);
      if (needExtra) {
        const pageAddrs: PublicKey[] = [];
        for (let i = start; i <= last; i++) {
          pageAddrs.push(postPagePda(this.programId, this.forum, i));
        }
        pageInfos = await this.withFailover((c) =>
          c.getMultipleAccountsInfo(pageAddrs, this.commitment)
        );
        for (let i = 0; i < pageAddrs.length; i++) {
          const page = start + i;
          const acc = pageInfos[i];
          const posts = acc?.data ? decodePostPage(asBytes(acc.data as Uint8Array)) : [];
          this.cache.set(`pp:${page}`, { at: Date.now(), value: posts });
        }
      } else {
        for (let i = 0; i < speculative; i++) {
          const acc = pageInfos[i];
          const posts = acc?.data ? decodePostPage(asBytes(acc.data as Uint8Array)) : [];
          this.cache.set(`pp:${i}`, { at: Date.now(), value: posts });
        }
      }

      const posts: PostRecord[] = [];
      for (let i = start; i <= last; i++) {
        const hit = this.cache.get(`pp:${i}`);
        if (hit) posts.push(...(hit.value as PostRecord[]));
      }
      posts.sort((a, b) => b.id - a.id);
      return { forum, posts };
    });
  }

  async getMultiplePostPages(from: number, to: number): Promise<PostRecord[][]> {
    const addrs: PublicKey[] = [];
    for (let i = from; i <= to; i++) addrs.push(postPagePda(this.programId, this.forum, i));
    if (addrs.length === 0) return [];
    const infos = await this.withFailover((c) =>
      c.getMultipleAccountsInfo(addrs, this.commitment)
    );
    return infos.map((acc, i) => {
      const posts = acc?.data ? decodePostPage(asBytes(acc.data as Uint8Array)) : [];
      this.cache.set(`pp:${from + i}`, { at: Date.now(), value: posts });
      return posts;
    });
  }

  /**
   * Load comments for a post. Fetches every comment page in **one** multi-get
   * (pages are cached), then filters client-side by postId.
   */
  /**
   * Comments for one post. Walks newest pages first and stops once the post's
   * own comment count is collected, so a recent thread does not pull every page.
   */
  async commentsForPost(
    postId: number,
    forum: ForumAccount,
    expectedCount = 0
  ): Promise<CommentRecord[]> {
    if (expectedCount <= 0) return [];
    const last = Math.max(
      0,
      Math.max(forum.commentPageCount, Math.ceil(forum.commentCount / COMMENTS_PER_PAGE) || 1) - 1
    );
    const out: CommentRecord[] = [];
    for (let page = last; page >= 0 && out.length < expectedCount; page--) {
      const [records] = await this.getCommentPages(page, page);
      for (const cmt of records ?? []) {
        if (cmt.postId === postId) out.push(cmt);
      }
    }
    return out.sort((a, b) => a.id - b.id);
  }

  /** Post pages `[from, to]` inclusive, for the history pager. */
  async postsOnPages(from: number, to: number): Promise<PostRecord[]> {
    if (to < from) return [];
    const pages = await this.getMultiplePostPages(from, to);
    const posts: PostRecord[] = [];
    for (const page of pages) posts.push(...page);
    posts.sort((a, b) => b.id - a.id);
    return posts;
  }

  async getCommentPages(from: number, to: number): Promise<CommentRecord[][]> {
    const missing: number[] = [];
    const results: CommentRecord[][] = [];
    for (let i = from; i <= to; i++) {
      const hit = this.cache.get(`cp:${i}`);
      if (hit && Date.now() - hit.at < this.ttl) {
        results[i - from] = hit.value as CommentRecord[];
      } else {
        missing.push(i);
        results[i - from] = [];
      }
    }
    if (missing.length === 0) return results;

    const addrs = missing.map((i) => commentPagePda(this.programId, this.forum, i));
    const infos = await this.withFailover((c) =>
      c.getMultipleAccountsInfo(addrs, this.commitment)
    );
    for (let j = 0; j < missing.length; j++) {
      const page = missing[j]!;
      const acc = infos[j];
      const comments = acc?.data ? decodeCommentPage(asBytes(acc.data as Uint8Array)) : [];
      this.cache.set(`cp:${page}`, { at: Date.now(), value: comments });
      results[page - from] = comments;
    }
    return results;
  }

  async holderAmount(owner: PublicKey, tokenProgram: PublicKey): Promise<bigint> {
    const ata = associatedTokenAddress(this.mint, owner, tokenProgram);
    const acc = await this.withFailover((c) => c.getAccountInfo(ata, this.commitment));
    if (!acc?.data) return BigInt(0);
    return tokenAmount(asBytes(acc.data as Uint8Array));
  }

  /**
   * Refresh the board without a WebSocket. Magic Router HTTP is the live path;
   * `onAccountChange` opens `wss://…` and rpc-websockets rejects with a raw
   * `Event`, which Next’s overlay shows as `[object Event]`.
   */
  onForumChange(cb: () => void): () => void {
    const tick = () => {
      this.invalidate(true);
      this.invalidatePages();
      cb();
    };
    const id = setInterval(tick, 4_000);
    return () => clearInterval(id);
  }
}

export function pageIndexForPost(postId: number): number {
  return Math.floor(postId / POSTS_PER_PAGE);
}

/** Page indexes that still need a commit, oldest first. Empty when nothing is dirty. */
export function dirtyPageIndexes(committed: number, total: number, perPage: number): number[] {
  if (!(total > committed) || perPage <= 0) return [];
  const start = Math.floor(committed / perPage);
  const end = Math.floor((total - 1) / perPage);
  const out: number[] = [];
  for (let i = start; i <= end; i++) out.push(i);
  return out;
}

export function pageIndexForComment(commentId: number): number {
  return Math.floor(commentId / COMMENTS_PER_PAGE);
}

export type { AccountInfo };
