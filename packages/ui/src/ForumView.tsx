"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { PublicKey, Transaction, type Connection } from "@solana/web3.js";
import {
  ARWEAVE_ID_RE,
  BOOTSTRAP_MIN_SOL,
  COMMENTS_PER_PAGE,
  ER_VALIDATORS,
  FORUM_CATEGORIES,
  MAX_FREE_UPLOAD_BYTES,
  POSTS_PER_PAGE,
  TITLE_MAX,
  ForumReader,
  bootstrapForum,
  commentPagePda,
  createCommentIx,
  createPostIx,
  delegateCommentPageIx,
  delegatePostPageIx,
  encodePostTitle,
  fundTreasuryIx,
  maybeCommitIx,
  openCommentPageIx,
  openPostPageIx,
  pageIndexForComment,
  pageIndexForPost,
  parsePostTitle,
  postPagePda,
  sendForumTransaction,
  treasuryPda,
  type CommentRecord,
  type ForumAccount,
  type ForumCategory,
  type ForumWallet,
  type PostRecord,
} from "@holder-forum/sdk";
import { Markdown } from "./Markdown";
import { MarkdownEditor } from "./MarkdownEditor";

type SortMode = "hot" | "new" | "active";
type EditorMode = "write" | "preview";

const FEED_PAGE_SIZE = 8;
const COMMENT_ROOT_PAGE_SIZE = 6;

type CommentNode = CommentRecord & { children: CommentNode[] };

/** Embedded when replying to a comment so nesting works even if on-chain parent is 0 (legacy). */
const HF_PARENT_RE = /^<!--\s*hf:parent=(\d+)\s*-->\s*/;

function extractParentHint(body: string): number | null {
  const m = HF_PARENT_RE.exec(body);
  return m ? Number(m[1]) : null;
}

function stripParentHint(body: string): string {
  return body.replace(HF_PARENT_RE, "");
}

function withParentHint(markdown: string, parentCommentId: number): string {
  return `<!--hf:parent=${parentCommentId}-->\n${markdown.trim()}`;
}

function friendlyForumError(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  const insuf = raw.match(/insufficient lamports\s+(\d+),\s*need\s+(\d+)/i);
  if (insuf) {
    const have = Number(insuf[1]) / 1e9;
    const need = Number(insuf[2]) / 1e9;
    return (
      `Not enough SOL to open the forum. One of the page accounts needs ~${need.toFixed(3)} SOL ` +
      `rent-exempt, but only ~${have.toFixed(3)} SOL was left in the wallet. ` +
      `Add SOL so the wallet has at least ~${BOOTSTRAP_MIN_SOL} SOL, then try again.`
    );
  }
  if (/insufficient lamports|0x1\b/i.test(raw) && /Transfer:/i.test(raw)) {
    return (
      `Not enough SOL for forum rent. Opening it creates several accounts ` +
      `(about ${BOOTSTRAP_MIN_SOL} SOL). Add SOL and try again.`
    );
  }
  if (/AccountNotInitialized|0xbc4/i.test(raw)) {
    return (
      "Forum open failed a MagicBlock delegation account check (0xbc4). " +
      "Try Open forum again. If rent already landed from an older attempt, " +
      "the retry only finishes delegation and does not re-pay rent."
    );
  }
  if (/AccountOwnedByWrongProgram|0xbbf/i.test(raw)) {
    return (
      "A forum account is already owned by MagicBlock’s delegation program. " +
      "Refresh the page — setup may already be complete."
    );
  }
  if (/blockhash not found/i.test(raw)) {
    return (
      "The wallet took too long or the send RPC did not recognize the blockhash. " +
      "Click Open forum again and approve promptly."
    );
  }
  if (/modified data of an account it does not own/i.test(raw)) {
    return (
      "Forum program is still the old build that writes the account after " +
      "MagicBlock takes ownership. The updated program must be deployed first."
    );
  }
  return raw;
}

export interface HolderForumProps {
  programId: string;
  mint: string;
  tokenProgram: string;
  routerUrl: string;
  validator?: string;
  walletPublicKey: string | null;
  signTransaction?: (tx: Transaction) => Promise<Transaction>;
  signAllTransactions?: (txs: Transaction[]) => Promise<Transaction[]>;
  uploadBody: (markdown: string) => Promise<string>;
  fetchBody: (arweaveId: string) => Promise<string | null>;
  walletTokenUiAmount?: number | null;
  walletSol?: number | null;
  baseConnection?: Connection;
}

function shortPk(pk: string): string {
  return pk.length > 8 ? `${pk.slice(0, 4)}…${pk.slice(-4)}` : pk;
}

function age(unix: number): string {
  const s = Math.max(0, Math.floor(Date.now() / 1000 - unix));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

function heatScore(p: PostRecord): number {
  const hours = Math.max(0.25, (Date.now() / 1000 - p.createdUnix) / 3600);
  return (p.commentCount + 1) / Math.pow(hours + 2, 1.35);
}

function isHot(p: PostRecord): boolean {
  return p.commentCount >= 2 && heatScore(p) >= 0.35;
}

function plainPreview(md: string, max = 180): string {
  const plain = md
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`]+`/g, " ")
    .replace(/!\[[^\]]*]\([^)]+\)/g, " ")
    .replace(/\[[^\]]*]\([^)]+\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^>\s?/gm, "")
    .replace(/^[-*]\s+/gm, "")
    .replace(/[*_~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (plain.length <= max) return plain;
  return `${plain.slice(0, max).trim()}…`;
}

function buildCommentTree(
  list: CommentRecord[],
  bodies: Record<string, string>
): CommentNode[] {
  const map = new Map<number, CommentNode>();
  for (const c of list) map.set(c.id, { ...c, children: [] });
  const roots: CommentNode[] = [];
  for (const c of list) {
    const node = map.get(c.id)!;
    const body = bodies[c.arweaveId];
    const hint = body ? extractParentHint(body) : null;
    // Hint wins (needed when replying to legacy comment id 0 where on-chain parent is also 0).
    // Otherwise parent_comment_id == 0 means top-level (reply to the post).
    const parentId = hint != null ? hint : c.parentCommentId;
    const nested = hint != null || c.parentCommentId !== 0;
    if (nested && map.has(parentId)) {
      map.get(parentId)!.children.push(node);
    } else {
      roots.push(node);
    }
  }
  const sortRec = (nodes: CommentNode[]) => {
    nodes.sort((a, b) => a.createdUnix - b.createdUnix);
    for (const n of nodes) sortRec(n.children);
  };
  sortRec(roots);
  return roots;
}

function indexStorageKey(programId: string, mint: string): string {
  return `hf:index:${programId}:${mint}`;
}

function readStoredIndex(
  programId: string,
  mint: string
): { forum: ForumAccount; posts: PostRecord[] } | null {
  try {
    const raw = sessionStorage.getItem(indexStorageKey(programId, mint));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { forum: ForumAccount; posts: PostRecord[]; at: number };
    if (!parsed?.forum || !Array.isArray(parsed.posts)) return null;
    if (Date.now() - (parsed.at ?? 0) > 86_400_000) return null;
    return { forum: parsed.forum, posts: parsed.posts };
  } catch {
    return null;
  }
}

function writeStoredIndex(
  programId: string,
  mint: string,
  forum: ForumAccount,
  posts: PostRecord[]
): void {
  try {
    sessionStorage.setItem(
      indexStorageKey(programId, mint),
      JSON.stringify({ forum, posts, at: Date.now() })
    );
  } catch {
    // ignore
  }
}

function authorHue(pk: string): number {
  let h = 0;
  for (let i = 0; i < pk.length; i++) h = (h * 33 + pk.charCodeAt(i)) >>> 0;
  return h % 360;
}

function AuthorAvatar({ pk }: { pk: string }) {
  const hue = authorHue(pk);
  return (
    <span
      className="hf-avatar"
      style={{ background: `hsl(${hue} 62% 58%)` }}
      aria-hidden
    >
      {pk.slice(0, 2).toUpperCase()}
    </span>
  );
}

function pageWindow(current: number, total: number): number[] {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
  const pages = new Set<number>([1, total, current, current - 1, current + 1]);
  if (current <= 3) {
    pages.add(2);
    pages.add(3);
    pages.add(4);
  }
  if (current >= total - 2) {
    pages.add(total - 1);
    pages.add(total - 2);
    pages.add(total - 3);
  }
  return [...pages].filter((p) => p >= 1 && p <= total).sort((a, b) => a - b);
}

function Pager({
  page,
  pageCount,
  totalItems,
  pageSize,
  onChange,
  noun = "posts",
}: {
  page: number;
  pageCount: number;
  totalItems: number;
  pageSize: number;
  onChange: (p: number) => void;
  noun?: string;
}) {
  if (pageCount <= 1) return null;
  const from = (page - 1) * pageSize + 1;
  const to = Math.min(page * pageSize, totalItems);
  const window = pageWindow(page, pageCount);
  return (
    <nav className="hf-pager" aria-label="Pagination">
      <p className="hf-pager-meta">
        <strong>
          {from}–{to}
        </strong>{" "}
        of {totalItems} {noun}
      </p>
      <div className="hf-pager-nav">
        <button
          type="button"
          className="hf-pager-edge"
          disabled={page <= 1}
          aria-label="Previous page"
          onClick={() => onChange(page - 1)}
        >
          Prev
        </button>
        {window.map((p, i) => {
          const prev = window[i - 1];
          const gap = prev != null && p - prev > 1;
          return (
            <span key={p} style={{ display: "contents" }}>
              {gap ? <span className="hf-muted" style={{ padding: "0 0.15rem" }}>…</span> : null}
              <button
                type="button"
                className={p === page ? "is-active" : undefined}
                aria-current={p === page ? "page" : undefined}
                onClick={() => onChange(p)}
              >
                {p}
              </button>
            </span>
          );
        })}
        <button
          type="button"
          className="hf-pager-edge"
          disabled={page >= pageCount}
          aria-label="Next page"
          onClick={() => onChange(page + 1)}
        >
          Next
        </button>
      </div>
    </nav>
  );
}

function VoteRail({ score, hot }: { score: number; hot?: boolean }) {
  return (
    <div className="hf-vote" aria-hidden>
      <span className="hf-vote-chevron">
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
          <path d="M6 2.5 9.5 7H2.5L6 2.5Z" fill="currentColor" />
        </svg>
      </span>
      <span className={`hf-vote-score${hot ? " is-hot" : ""}`}>{score}</span>
      <span className="hf-vote-label">replies</span>
      <span className="hf-vote-chevron">
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
          <path d="M6 9.5 2.5 5h7L6 9.5Z" fill="currentColor" />
        </svg>
      </span>
    </div>
  );
}

function SearchIcon() {
  return (
    <svg className="hf-search-icon" width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden>
      <circle cx="6" cy="6" r="4.25" stroke="currentColor" strokeWidth="1.4" />
      <path d="M9.2 9.2 12 12" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

export function HolderForum(props: HolderForumProps) {
  const programId = useMemo(() => {
    try {
      return props.programId ? new PublicKey(props.programId) : null;
    } catch {
      return null;
    }
  }, [props.programId]);
  const mint = useMemo(() => new PublicKey(props.mint), [props.mint]);
  const tokenProgram = useMemo(() => new PublicKey(props.tokenProgram), [props.tokenProgram]);
  const validator = useMemo(
    () => new PublicKey(props.validator?.trim() || ER_VALIDATORS.asia),
    [props.validator]
  );

  const reader = useMemo(() => {
    if (!programId) return null;
    return new ForumReader({ programId, mint, routerUrl: props.routerUrl });
  }, [programId, mint, props.routerUrl]);

  const keys = useMemo(() => {
    if (!programId) return null;
    return { programId, mint, tokenProgram };
  }, [programId, mint, tokenProgram]);

  const cachedBoot = useMemo(() => {
    if (!programId) return null;
    return readStoredIndex(programId.toBase58(), mint.toBase58());
  }, [programId, mint]);

  const [forum, setForum] = useState<ForumAccount | null | undefined>(() =>
    cachedBoot ? cachedBoot.forum : undefined
  );
  const [posts, setPosts] = useState<PostRecord[]>(() => cachedBoot?.posts ?? []);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [holds, setHolds] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [thread, setThread] = useState<PostRecord | null>(null);
  const threadRef = useRef(thread);
  threadRef.current = thread;
  const [comments, setComments] = useState<CommentRecord[]>([]);
  const [bodies, setBodies] = useState<Record<string, string>>({});
  const bodiesRef = useRef(bodies);
  bodiesRef.current = bodies;
  const bodyInflight = useRef(new Map<string, Promise<string | null>>());
  const [threadLoading, setThreadLoading] = useState(false);
  const [category, setCategory] = useState<ForumCategory>("general");
  const [sort, setSort] = useState<SortMode>("hot");
  const [query, setQuery] = useState("");
  const [feedPage, setFeedPage] = useState(1);
  const [commentPage, setCommentPage] = useState(1);
  const [composeOpen, setComposeOpen] = useState(false);
  const [composeCategory, setComposeCategory] = useState<ForumCategory>("general");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [composeMode, setComposeMode] = useState<EditorMode>("write");
  const [reply, setReply] = useState("");
  const [replyMode, setReplyMode] = useState<EditorMode>("write");
  const [replyTo, setReplyTo] = useState<number | null>(null);
  const [inlineReply, setInlineReply] = useState("");
  const [inlineMode, setInlineMode] = useState<EditorMode>("write");
  const [copied, setCopied] = useState(false);
  const [linkCopied, setLinkCopied] = useState<number | null>(null);

  const treasury = useMemo(
    () => (programId ? treasuryPda(programId, mint).toBase58() : ""),
    [programId, mint]
  );

  const categoryCounts = useMemo(() => {
    const counts: Record<ForumCategory, number> = { general: 0, proposal: 0 };
    for (const p of posts) counts[parsePostTitle(p.title).category] += 1;
    return counts;
  }, [posts]);

  const filteredPosts = useMemo(() => {
    const q = query.trim().toLowerCase();
    let list = posts.filter((p) => parsePostTitle(p.title).category === category);
    if (q) {
      list = list.filter((p) => {
        const { title: t } = parsePostTitle(p.title);
        const preview = bodies[p.arweaveId] ? plainPreview(bodies[p.arweaveId], 400) : "";
        return (
          t.toLowerCase().includes(q) ||
          p.author.toLowerCase().includes(q) ||
          preview.toLowerCase().includes(q)
        );
      });
    }
    const sorted = [...list];
    if (sort === "new") sorted.sort((a, b) => b.createdUnix - a.createdUnix);
    else if (sort === "active")
      sorted.sort((a, b) => b.commentCount - a.commentCount || b.createdUnix - a.createdUnix);
    else sorted.sort((a, b) => heatScore(b) - heatScore(a) || b.createdUnix - a.createdUnix);
    return sorted;
  }, [posts, category, query, sort, bodies]);

  const feedPageCount = Math.max(1, Math.ceil(filteredPosts.length / FEED_PAGE_SIZE));
  const pagedPosts = useMemo(() => {
    const page = Math.min(feedPage, feedPageCount);
    const start = (page - 1) * FEED_PAGE_SIZE;
    return filteredPosts.slice(start, start + FEED_PAGE_SIZE);
  }, [filteredPosts, feedPage, feedPageCount]);

  const commentTree = useMemo(() => buildCommentTree(comments, bodies), [comments, bodies]);
  const commentPageCount = Math.max(1, Math.ceil(commentTree.length / COMMENT_ROOT_PAGE_SIZE));
  const pagedCommentRoots = useMemo(() => {
    const page = Math.min(commentPage, commentPageCount);
    const start = (page - 1) * COMMENT_ROOT_PAGE_SIZE;
    return commentTree.slice(start, start + COMMENT_ROOT_PAGE_SIZE);
  }, [commentTree, commentPage, commentPageCount]);

  const commentsById = useMemo(() => {
    const m = new Map<number, CommentRecord>();
    for (const c of comments) m.set(c.id, c);
    return m;
  }, [comments]);
  const bodyBytes = useMemo(() => new TextEncoder().encode(body).length, [body]);

  useEffect(() => {
    setFeedPage(1);
  }, [category, sort, query]);

  useEffect(() => {
    setFeedPage((p) => Math.min(p, feedPageCount));
  }, [feedPageCount]);

  useEffect(() => {
    setCommentPage(1);
  }, [thread?.id]);

  useEffect(() => {
    setCommentPage((p) => Math.min(p, commentPageCount));
  }, [commentPageCount]);

  const applyIndex = useCallback(
    (idx: { forum: ForumAccount; posts: PostRecord[] } | null) => {
      setLoadError(null);
      setForum(idx ? idx.forum : null);
      setPosts(idx?.posts ?? []);
      if (idx && programId) {
        writeStoredIndex(programId.toBase58(), mint.toBase58(), idx.forum, idx.posts);
      }
    },
    [programId, mint]
  );

  const refresh = useCallback(
    async (opts?: { soft?: boolean }) => {
      if (!reader) return;
      try {
        reader.invalidate(opts?.soft === true);
        const idx = await reader.loadIndex();
        applyIndex(idx);
      } catch (e) {
        if (forum === undefined) {
          setLoadError(e instanceof Error ? e.message : "Could not reach Magic Router.");
        }
      }
    },
    [reader, applyIndex, forum]
  );

  useEffect(() => {
    if (!reader) return;
    let cancelled = false;
    void reader
      .loadIndex()
      .then((idx) => {
        if (!cancelled) applyIndex(idx);
      })
      .catch((e) => {
        if (cancelled) return;
        if (forum === undefined) {
          setLoadError(e instanceof Error ? e.message : "Could not reach Magic Router.");
        }
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- boot once per reader
  }, [reader]);

  useEffect(() => {
    if (!reader) return;
    return reader.onForumChange(() => {
      void refresh({ soft: true }).catch(() => {
        // poll miss — keep the last good index on screen
      });
    });
  }, [reader, refresh]);

  useEffect(() => {
    if (props.walletTokenUiAmount !== undefined) {
      if (props.walletTokenUiAmount === null) return;
      setHolds(props.walletTokenUiAmount > 0);
      return;
    }
    if (!reader || !props.walletPublicKey) {
      setHolds(false);
      return;
    }
    let cancelled = false;
    void reader
      .holderAmount(new PublicKey(props.walletPublicKey), tokenProgram)
      .then((n) => {
        if (!cancelled) setHolds(n > BigInt(0));
      })
      .catch(() => {
        if (!cancelled) setHolds(false);
      });
    return () => {
      cancelled = true;
    };
  }, [reader, props.walletPublicKey, tokenProgram, props.walletTokenUiAmount]);

  useEffect(() => {
    if (!composeOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setComposeOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [composeOpen]);

  const rememberBody = useCallback((id: string, text: string) => {
    if (!id || !text) return;
    if (bodiesRef.current[id]) return;
    bodiesRef.current = { ...bodiesRef.current, [id]: text };
    setBodies((prev) => (prev[id] ? prev : { ...prev, [id]: text }));
  }, []);

  const pullBody = useCallback(
    (id: string): Promise<string | null> => {
      if (!ARWEAVE_ID_RE.test(id)) return Promise.resolve(null);
      const have = bodiesRef.current[id];
      if (have) return Promise.resolve(have);
      const existing = bodyInflight.current.get(id);
      if (existing) return existing;
      const pending = (async () => {
        try {
          const text = await props.fetchBody(id);
          if (text) rememberBody(id, text);
          return text;
        } catch {
          return null;
        } finally {
          bodyInflight.current.delete(id);
        }
      })();
      bodyInflight.current.set(id, pending);
      return pending;
    },
    [props.fetchBody, rememberBody]
  );

  // Progressive body previews for the current feed page
  useEffect(() => {
    if (!pagedPosts.length) return;
    for (const p of pagedPosts) {
      if (ARWEAVE_ID_RE.test(p.arweaveId) && !bodiesRef.current[p.arweaveId]) {
        void pullBody(p.arweaveId);
      }
    }
  }, [pagedPosts, pullBody]);

  // Same for the open thread: post body + every comment/reply. Keep retrying
  // while the skeleton is up — a fresh Arweave id often 404s for a few seconds.
  useEffect(() => {
    if (!thread) return;
    const ids = [thread.arweaveId, ...comments.map((c) => c.arweaveId)].filter(
      (id) => ARWEAVE_ID_RE.test(id) && !bodies[id]
    );
    if (!ids.length) return;
    for (const id of ids) void pullBody(id);
    const timer = window.setInterval(() => {
      for (const id of ids) {
        if (!bodiesRef.current[id]) void pullBody(id);
      }
    }, 1_500);
    return () => window.clearInterval(timer);
  }, [thread, comments, bodies, pullBody]);

  const canPost = Boolean(props.walletPublicKey) && holds;
  const solBalance = props.walletSol;
  const needsMoreSol = solBalance != null && solBalance < BOOTSTRAP_MIN_SOL;

  const wallet = useCallback((): ForumWallet | null => {
    if (!props.walletPublicKey || !props.signTransaction) return null;
    return {
      publicKey: new PublicKey(props.walletPublicKey),
      signTransaction: props.signTransaction,
      signAllTransactions: props.signAllTransactions,
    };
  }, [props.walletPublicKey, props.signTransaction, props.signAllTransactions]);

  const run = useCallback(
    async (label: string, fn: (w: ForumWallet) => Promise<unknown>) => {
      const w = wallet();
      if (!w || !reader || !keys) {
        setErr("Connect a wallet that holds this token.");
        return;
      }
      setBusy(label);
      setErr(null);
      try {
        await fn(w);
        await refresh({ soft: true });
      } catch (e) {
        setErr(friendlyForumError(e));
      } finally {
        setBusy(null);
      }
    },
    [wallet, reader, keys, refresh]
  );

  const loadBodies = useCallback(
    async (ids: string[]) => {
      const unique = [...new Set(ids.filter((id) => ARWEAVE_ID_RE.test(id)))];
      await Promise.all(unique.map((id) => pullBody(id)));
    },
    [pullBody]
  );

  const openThread = useCallback(
    async (p: PostRecord) => {
      if (!reader || !forum) return;
      const switching = threadRef.current?.id !== p.id;
      setThread(p);
      if (switching) {
        setComments([]);
        setReplyTo(null);
        setInlineReply("");
      }
      setThreadLoading(true);
      setErr(null);
      void loadBodies([p.arweaveId]);
      try {
        const list = await reader.commentsForPost(p.id, forum);
        setComments((prev) => {
          const seen = new Set(list.map((c) => c.arweaveId));
          const pending = prev.filter((c) => c.arweaveId && !seen.has(c.arweaveId));
          return pending.length ? [...list, ...pending] : list;
        });
        void loadBodies(list.map((c) => c.arweaveId));
      } catch (e) {
        setErr(e instanceof Error ? e.message : "Could not load thread.");
      } finally {
        setThreadLoading(false);
      }
    },
    [reader, forum, loadBodies]
  );

  const ensurePostPage = useCallback(
    async (w: ForumWallet, postCount: number) => {
      const page = pageIndexForPost(postCount);
      const needPage = postCount > 0 && postCount % POSTS_PER_PAGE === 0;
      if (!needPage || !keys || !reader) return page;
      const l1 = props.baseConnection ?? reader.connection();
      const addr = postPagePda(keys.programId, reader.forum, page);
      const info = await l1.getAccountInfo(addr, "confirmed");
      if (!info) {
        await sendForumTransaction({
          connection: l1,
          routerUrl: "",
          wallet: w,
          instructions: [
            openPostPageIx(keys, w.publicKey, page),
            delegatePostPageIx(keys, w.publicKey, page, validator),
          ],
        });
      } else {
        try {
          await sendForumTransaction({
            connection: l1,
            routerUrl: "",
            wallet: w,
            instructions: [delegatePostPageIx(keys, w.publicKey, page, validator)],
          });
        } catch {
          // already delegated
        }
      }
      return page;
    },
    [keys, reader, validator, props.baseConnection]
  );

  const ensureCommentPage = useCallback(
    async (w: ForumWallet, commentCount: number) => {
      const page = pageIndexForComment(commentCount);
      const needPage = commentCount > 0 && commentCount % COMMENTS_PER_PAGE === 0;
      if (!needPage || !keys || !reader) return page;
      const l1 = props.baseConnection ?? reader.connection();
      const addr = commentPagePda(keys.programId, reader.forum, page);
      const info = await l1.getAccountInfo(addr, "confirmed");
      if (!info) {
        await sendForumTransaction({
          connection: l1,
          routerUrl: "",
          wallet: w,
          instructions: [
            openCommentPageIx(keys, w.publicKey, page),
            delegateCommentPageIx(keys, w.publicKey, page, validator),
          ],
        });
      } else {
        try {
          await sendForumTransaction({
            connection: l1,
            routerUrl: "",
            wallet: w,
            instructions: [delegateCommentPageIx(keys, w.publicKey, page, validator)],
          });
        } catch {
          // already delegated
        }
      }
      return page;
    },
    [keys, reader, validator, props.baseConnection]
  );

  const openComposer = useCallback(() => {
    setComposeCategory(category);
    setComposeMode("write");
    setErr(null);
    setComposeOpen(true);
  }, [category]);

  const submitPost = useCallback(() => {
    if (!forum || !reader) return;
    const conn = reader.connection();
    void run("Publishing", async (w) => {
      const markdown = body.trim();
      const id = await props.uploadBody(markdown);
      rememberBody(id, markdown);
      const page = await ensurePostPage(w, forum.postCount);
      const onChainTitle = encodePostTitle(composeCategory, title);
      await sendForumTransaction({
        connection: conn,
        routerUrl: props.routerUrl,
        wallet: w,
        instructions: [createPostIx(keys!, w.publicKey, onChainTitle, id, page)],
      });
      reader.invalidatePages();
      setTitle("");
      setBody("");
      setComposeOpen(false);
      setCategory(composeCategory);
    });
  }, [forum, reader, run, props, body, ensurePostPage, composeCategory, title, keys, rememberBody]);

  const postComment = useCallback(
    (markdown: string, parentCommentId: number | null, onDone?: () => void) => {
      if (!forum || !reader || !thread) return;
      const conn = reader.connection();
      void run("Posting reply", async (w) => {
        const trimmed = markdown.trim();
        // Nested replies always carry a body hint so threading survives legacy id=0 comments
        // (on-chain parent 0 == "reply to post", same as the first comment's id).
        const payload =
          parentCommentId != null ? withParentHint(trimmed, parentCommentId) : trimmed;
        const id = await props.uploadBody(payload);
        rememberBody(id, payload);
        const cPage = await ensureCommentPage(w, forum.commentCount);
        await sendForumTransaction({
          connection: conn,
          routerUrl: props.routerUrl,
          wallet: w,
          instructions: [
            createCommentIx(
              keys!,
              w.publicKey,
              thread.id,
              parentCommentId ?? 0,
              id,
              pageIndexForPost(thread.id),
              cPage
            ),
          ],
        });
        setComments((prev) => {
          if (prev.some((c) => c.arweaveId === id)) return prev;
          return [
            ...prev,
            {
              id: forum.commentCount + 1,
              postId: thread.id,
              parentCommentId: parentCommentId ?? 0,
              author: w.publicKey.toBase58(),
              createdUnix: Math.floor(Date.now() / 1000),
              arweaveId: id,
            },
          ];
        });
        onDone?.();
        reader.invalidatePages();
        await openThread(thread);
      });
    },
    [forum, reader, thread, run, props, ensureCommentPage, keys, openThread, rememberBody]
  );

  const copyPostLink = useCallback((postId: number) => {
    const url = `${window.location.href.split("#")[0]}#post-${postId}`;
    void navigator.clipboard?.writeText(url).then(() => {
      setLinkCopied(postId);
      setTimeout(() => setLinkCopied(null), 1400);
    });
  }, []);

  if (!programId) {
    return (
      <div className="hf-forum hf-page">
        <div className="hf-card hf-empty">
          <p className="hf-post-title">Forum is not configured</p>
          <p className="hf-muted">Set NEXT_PUBLIC_FORUM_PROGRAM_ID after you deploy the program.</p>
        </div>
      </div>
    );
  }

  if (forum === undefined && !loadError) {
    return (
      <div className="hf-forum hf-page" aria-busy="true">
        <div className="hf-skel" />
        <div className="hf-skel" style={{ width: "70%" }} />
        <div className="hf-skel" style={{ width: "50%" }} />
      </div>
    );
  }

  if (loadError && forum === undefined) {
    return (
      <div className="hf-forum hf-page">
        <div className="hf-card hf-empty">
          <p className="hf-post-title">Forum is taking a moment</p>
          <p className="hf-muted">Live reads go through Magic Router. Try again in a second.</p>
          <p className="hf-err">{loadError}</p>
          <button type="button" className="hf-btn" style={{ marginTop: 16 }} onClick={() => void refresh({ soft: true })}>
            Retry
          </button>
        </div>
      </div>
    );
  }

  const conn = reader!.connection();

  if (forum === null) {
    return (
      <div className="hf-forum hf-page">
        <header className="hf-community">
          <div className="hf-community-brand">
            <div className="hf-community-mark" aria-hidden>
              <span>F</span>
            </div>
            <div>
              <h2>Forum</h2>
              <p className="hf-community-sub">Holders discuss this token on-chain.</p>
            </div>
          </div>
        </header>
        <div className="hf-card hf-empty">
          <p className="hf-post-title">Open this forum</p>
          <p className="hf-muted">
            First holder stands it up once (~{BOOTSTRAP_MIN_SOL} SOL rent). Posts then settle on
            MagicBlock near-zero fees.
          </p>
          {!canPost && (
            <p className="hf-muted" style={{ marginTop: 8 }}>
              Need this token in your wallet (not only deposited in the DAO).
            </p>
          )}
          {canPost && needsMoreSol && (
            <p className="hf-err" style={{ marginTop: 8 }}>
              Wallet has ~{solBalance!.toFixed(3)} SOL — need at least ~{BOOTSTRAP_MIN_SOL} SOL.
            </p>
          )}
          <button
            type="button"
            className="hf-btn hf-btn-lg"
            style={{ marginTop: 16 }}
            disabled={!canPost || needsMoreSol || !wallet() || !props.baseConnection || Boolean(busy)}
            onClick={() =>
              void run("Opening forum", async (w) => {
                if (!props.baseConnection || !keys) {
                  throw new Error("Base Solana connection missing — cannot open forum.");
                }
                await bootstrapForum({
                  connection: props.baseConnection,
                  keys,
                  wallet: w,
                  validator,
                  routerUrl: props.routerUrl,
                });
              })
            }
          >
            {busy ?? "Open forum"}
          </button>
          {!props.baseConnection && (
            <p className="hf-err" style={{ marginTop: 8 }}>
              Base Solana RPC is not wired — Open forum needs L1.
            </p>
          )}
          {err && <p className="hf-err">{err}</p>}
        </div>
      </div>
    );
  }

  if (!forum) return null;

  const composerModal = composeOpen ? (
    <div
      className="hf-modal"
      role="dialog"
      aria-modal="true"
      aria-labelledby="hf-compose-title"
      onClick={(e) => {
        if (e.target === e.currentTarget) setComposeOpen(false);
      }}
    >
      <div className="hf-modal-panel">
        <div className="hf-modal-head">
          <div>
            <h3 id="hf-compose-title">Create a post</h3>
            <p className="hf-muted" style={{ margin: "0.35rem 0 0", fontSize: "0.75rem" }}>
              Title on-chain · body on Arweave · Markdown supported
            </p>
          </div>
          <button type="button" className="hf-modal-close" aria-label="Close" onClick={() => setComposeOpen(false)}>
            ×
          </button>
        </div>

        <div className="hf-seg" role="tablist" aria-label="Post category">
          {FORUM_CATEGORIES.map((c) => (
            <button
              key={c.id}
              type="button"
              role="tab"
              aria-selected={composeCategory === c.id}
              onClick={() => setComposeCategory(c.id)}
            >
              {c.label}
            </button>
          ))}
        </div>

        <input
          className="hf-input"
          placeholder="Title"
          value={title}
          maxLength={TITLE_MAX - 2}
          disabled={!canPost || Boolean(busy)}
          onChange={(e) => setTitle(e.target.value)}
          autoFocus
        />

        <MarkdownEditor
          value={body}
          onChange={setBody}
          mode={composeMode}
          onModeChange={setComposeMode}
          disabled={!canPost || Boolean(busy)}
          placeholder={canPost ? "What are your thoughts?" : "Hold this token in your wallet to post"}
          bytesLabel={`${bodyBytes.toLocaleString()} / ${MAX_FREE_UPLOAD_BYTES.toLocaleString()} bytes`}
        />

        {!canPost && (
          <p className="hf-muted" style={{ margin: 0, fontSize: "0.75rem" }}>
            Hold this token in your wallet (not only in the DAO) to publish.
          </p>
        )}
        {err && <p className="hf-err">{err}</p>}
        <div style={{ display: "flex", gap: "0.5rem", justifyContent: "flex-end" }}>
          <button type="button" className="hf-btn hf-btn-ghost" onClick={() => setComposeOpen(false)} disabled={Boolean(busy)}>
            Cancel
          </button>
          <button
            type="button"
            className="hf-btn"
            disabled={
              !canPost || !title.trim() || !body.trim() || bodyBytes > MAX_FREE_UPLOAD_BYTES || Boolean(busy)
            }
            onClick={submitPost}
          >
            {busy ?? "Post"}
          </button>
        </div>
      </div>
    </div>
  ) : null;

  const renderComment = (node: CommentNode, depth: number): ReactNode => {
    const maxDepth = 6;
    const isReply = depth > 0;
    const bodyText = bodies[node.arweaveId];
    const hint = bodyText ? extractParentHint(bodyText) : null;
    const parentId = hint != null ? hint : node.parentCommentId;
    const parent =
      hint != null || node.parentCommentId !== 0 ? commentsById.get(parentId) : undefined;
    const open = replyTo === node.id;

    return (
      <div
        key={node.id}
        className={`hf-cmt${isReply ? " hf-cmt--reply" : " hf-cmt--root"}`}
        id={`comment-${node.id}`}
      >
        {isReply ? <div className="hf-cmt-gutter" title="Thread" aria-hidden /> : null}
        <div className="hf-cmt-panel">
          <div className="hf-cmt-head">
            {isReply && <span className="hf-cmt-pill">Reply</span>}
            <AuthorAvatar pk={node.author} />
            <span className="hf-cmt-author">{shortPk(node.author)}</span>
            {parent ? (
              <>
                <span className="hf-meta-dot" aria-hidden />
                <span className="hf-cmt-parent">
                  to <strong>{shortPk(parent.author)}</strong>
                </span>
              </>
            ) : null}
            <span className="hf-meta-dot" aria-hidden />
            <span>{age(node.createdUnix)} ago</span>
          </div>
          <div className="hf-cmt-body">
            {bodies[node.arweaveId] ? (
              <Markdown>{stripParentHint(bodies[node.arweaveId])}</Markdown>
            ) : (
              <div className="hf-skel" style={{ width: "70%" }} />
            )}
          </div>
          <div className="hf-post-actions" style={{ marginTop: 8 }}>
            <button
              type="button"
              className={`hf-reply-btn${open ? " is-open" : ""}`}
              disabled={!canPost || depth >= maxDepth}
              onClick={() => {
                setReplyTo(open ? null : node.id);
                setInlineReply("");
                setInlineMode("write");
              }}
            >
              {open ? "Cancel reply" : "Reply"}
            </button>
          </div>
          {open && (
            <div className="hf-inline-reply">
              <p className="hf-inline-reply-label">
                Replying to <strong>{shortPk(node.author)}</strong>
              </p>
              <MarkdownEditor
                value={inlineReply}
                onChange={setInlineReply}
                mode={inlineMode}
                onModeChange={setInlineMode}
                disabled={!canPost || Boolean(busy)}
                minRows={4}
                placeholder={`Reply to ${shortPk(node.author)}…`}
              />
              <div style={{ display: "flex", gap: "0.4rem", justifyContent: "flex-end" }}>
                <button
                  type="button"
                  className="hf-btn hf-btn-ghost hf-btn-sm"
                  onClick={() => setReplyTo(null)}
                  disabled={Boolean(busy)}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="hf-btn hf-btn-sm"
                  disabled={!canPost || !inlineReply.trim() || Boolean(busy)}
                  onClick={() =>
                    postComment(inlineReply, node.id, () => {
                      setInlineReply("");
                      setReplyTo(null);
                    })
                  }
                >
                  {busy ?? "Post reply"}
                </button>
              </div>
            </div>
          )}
          {node.children.length > 0 && depth < maxDepth && (
            <div className="hf-cmt-kids">{node.children.map((ch) => renderComment(ch, depth + 1))}</div>
          )}
        </div>
      </div>
    );
  };

  if (thread) {
    const parsed = parsePostTitle(thread.title);
    const hot = isHot(thread);
    return (
      <div className="hf-forum hf-page hf-thread">
        {composerModal}
        <button
          type="button"
          className="hf-btn hf-btn-ghost hf-btn-sm hf-thread-back"
          onClick={() => {
            setThread(null);
            setReply("");
            setReplyTo(null);
          }}
        >
          ← Back to feed
        </button>

        <article className={`hf-op${parsed.category === "proposal" ? " is-proposal" : ""}`}>
          <VoteRail score={thread.commentCount} hot={hot} />
          <div className="hf-op-main">
            <div className="hf-post-meta">
              <span className={`hf-flair hf-flair--${parsed.category === "proposal" ? "proposal" : "general"}`}>
                {parsed.category === "proposal" ? "Proposal" : "General"}
              </span>
              {hot && <span className="hf-flair hf-flair--hot">Hot</span>}
              <AuthorAvatar pk={thread.author} />
              <span>{shortPk(thread.author)}</span>
              <span className="hf-meta-dot" aria-hidden />
              <span>{age(thread.createdUnix)} ago</span>
            </div>
            <h3 className="hf-op-title">{parsed.title || thread.title}</h3>
            <div className="hf-op-body">
              {bodies[thread.arweaveId] ? (
                <Markdown>{bodies[thread.arweaveId]}</Markdown>
              ) : (
                <div>
                  <div className="hf-skel" style={{ marginBottom: 8 }} />
                  <div className="hf-skel" style={{ width: "88%", marginBottom: 8 }} />
                  <div className="hf-skel" style={{ width: "64%" }} />
                </div>
              )}
            </div>
            <div className="hf-post-actions" style={{ marginTop: 12 }}>
              <span className="hf-action" style={{ cursor: "default" }}>
                {thread.commentCount} comments
              </span>
              <button type="button" className="hf-action" onClick={() => copyPostLink(thread.id)}>
                {linkCopied === thread.id ? "Copied" : "Share"}
              </button>
            </div>
          </div>
        </article>

        <div className="hf-card hf-composer">
          <p className="hf-composer-label">Comment on this post</p>
          <MarkdownEditor
            value={reply}
            onChange={setReply}
            mode={replyMode}
            onModeChange={setReplyMode}
            disabled={!canPost || Boolean(busy)}
            minRows={5}
            placeholder={canPost ? "Share your thoughts with the thread…" : "Hold this token to comment"}
          />
          <div style={{ display: "flex", justifyContent: "flex-end" }}>
            <button
              type="button"
              className="hf-btn"
              disabled={!canPost || !reply.trim() || Boolean(busy)}
              onClick={() =>
                postComment(reply, null, () => {
                  setReply("");
                  setReplyMode("write");
                })
              }
            >
              {busy ?? "Post comment"}
            </button>
          </div>
          {!canPost && (
            <p className="hf-muted" style={{ margin: 0, fontSize: "0.75rem" }}>
              Hold this token to join the discussion.
            </p>
          )}
          {err && <p className="hf-err">{err}</p>}
        </div>

        <div id="hf-comments-anchor" className="hf-comments-head">
          <h4>Comments</h4>
          <span className="hf-muted" style={{ fontSize: "0.75rem" }}>
            {comments.length} total
            {threadLoading ? " · syncing…" : ""}
          </span>
        </div>

        <div className="hf-thread-tree">
          {threadLoading && comments.length === 0 ? (
            <div className="hf-card" style={{ padding: "1rem" }}>
              <div className="hf-skel" style={{ width: "40%", marginBottom: 10 }} />
              <div className="hf-skel" />
            </div>
          ) : null}
          {!threadLoading && comments.length === 0 ? (
            <div className="hf-card hf-empty" style={{ padding: "1.75rem 1rem" }}>
              <div className="hf-empty-icon">+</div>
              <p className="hf-post-title" style={{ fontSize: "0.95rem" }}>
                No comments yet
              </p>
              <p className="hf-muted" style={{ margin: "0.35rem 0 0", fontSize: "0.8rem" }}>
                Be the first to reply.
              </p>
            </div>
          ) : null}
          {pagedCommentRoots.map((n) => renderComment(n, 0))}
        </div>

        <Pager
          page={Math.min(commentPage, commentPageCount)}
          pageCount={commentPageCount}
          totalItems={commentTree.length}
          pageSize={COMMENT_ROOT_PAGE_SIZE}
          onChange={(p) => {
            setCommentPage(p);
            document.getElementById("hf-comments-anchor")?.scrollIntoView({ behavior: "smooth", block: "start" });
          }}
          noun="threads"
        />
      </div>
    );
  }

  const activeCat = FORUM_CATEGORIES.find((c) => c.id === category)!;

  return (
    <div className="hf-forum hf-page">
      {composerModal}

      <header className="hf-community">
        <div className="hf-community-brand">
          <div className="hf-community-mark" aria-hidden>
            <span>F</span>
          </div>
          <div>
            <h2>Forum</h2>
            <p className="hf-community-sub">
              Holder discussions · titles on-chain · bodies on Arweave
            </p>
          </div>
        </div>
        <div className="hf-community-actions">
          <span className="hf-chip">
            <strong>{forum.postCount}</strong> posts
          </span>
          <button type="button" className="hf-btn" disabled={!canPost || Boolean(busy)} onClick={openComposer}>
            Create post
          </button>
        </div>
      </header>

      <div className="hf-subnav" role="tablist" aria-label="Categories">
        {FORUM_CATEGORIES.map((c) => (
          <button
            key={c.id}
            type="button"
            role="tab"
            aria-selected={category === c.id}
            onClick={() => setCategory(c.id)}
          >
            {c.label}
            <span className="hf-subnav-count">{categoryCounts[c.id]}</span>
          </button>
        ))}
      </div>

      <div className="hf-controls">
        <div className="hf-sort" role="tablist" aria-label="Sort">
          {(
            [
              ["hot", "Hot"],
              ["new", "New"],
              ["active", "Active"],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={sort === id}
              onClick={() => setSort(id)}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="hf-search">
          <SearchIcon />
          <input
            type="search"
            placeholder={`Search ${activeCat.label.toLowerCase()}…`}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Search posts"
          />
        </div>
      </div>

      <div className="hf-feed">
        {filteredPosts.length === 0 ? (
          <div className="hf-card hf-empty">
            <div className="hf-empty-icon">+</div>
            <p className="hf-post-title">
              {query
                ? "No matches"
                : posts.length === 0
                  ? "Be the first to post"
                  : `No ${activeCat.label.toLowerCase()} yet`}
            </p>
            <p className="hf-muted" style={{ margin: "0.4rem auto 1.1rem", maxWidth: "22rem" }}>
              {query
                ? "Try a different search or clear the filter."
                : "Start a discussion for this collective."}
            </p>
            {!query && (
              <button type="button" className="hf-btn" disabled={!canPost || Boolean(busy)} onClick={openComposer}>
                Create post
              </button>
            )}
          </div>
        ) : (
          <>
            <ul className="hf-list">
              {pagedPosts.map((p, i) => {
                const parsed = parsePostTitle(p.title);
                const hot = isHot(p);
                const preview = bodies[p.arweaveId] ? plainPreview(bodies[p.arweaveId]) : null;
                const isProposal = parsed.category === "proposal";
                return (
                  <li key={p.id} style={{ animationDelay: `${Math.min(i, 8) * 35}ms` }}>
                    <article className={`hf-post${isProposal ? " is-proposal" : ""}`}>
                      <VoteRail score={p.commentCount} hot={hot} />
                      <div
                        className="hf-post-body"
                        role="button"
                        tabIndex={0}
                        onClick={() => void openThread(p)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            void openThread(p);
                          }
                        }}
                      >
                        <div className="hf-post-meta">
                          <span className={`hf-flair hf-flair--${isProposal ? "proposal" : "general"}`}>
                            {isProposal ? "Proposal" : "General"}
                          </span>
                          {hot && <span className="hf-flair hf-flair--hot">Hot</span>}
                          <AuthorAvatar pk={p.author} />
                          <span>{shortPk(p.author)}</span>
                          <span className="hf-meta-dot" aria-hidden />
                          <span>{age(p.createdUnix)} ago</span>
                        </div>
                        <h3 className="hf-post-title">{parsed.title || p.title}</h3>
                        {preview ? <p className="hf-post-preview">{preview}</p> : null}
                        <div className="hf-post-actions" onClick={(e) => e.stopPropagation()}>
                          <button type="button" className="hf-action" onClick={() => void openThread(p)}>
                            {p.commentCount} comments
                          </button>
                          <button type="button" className="hf-action" onClick={() => copyPostLink(p.id)}>
                            {linkCopied === p.id ? "Copied" : "Share"}
                          </button>
                        </div>
                      </div>
                    </article>
                  </li>
                );
              })}
            </ul>
            <Pager
              page={Math.min(feedPage, feedPageCount)}
              pageCount={feedPageCount}
              totalItems={filteredPosts.length}
              pageSize={FEED_PAGE_SIZE}
              onChange={(p) => {
                setFeedPage(p);
                document.querySelector(".hf-forum")?.scrollIntoView({ behavior: "smooth", block: "start" });
              }}
              noun="posts"
            />
          </>
        )}
      </div>

      {err && !composeOpen && <p className="hf-err">{err}</p>}

      <details className="hf-tools">
        <summary>Durability tools</summary>
        <div className="hf-tools-body">
          <p className="hf-muted" style={{ margin: 0, fontSize: 12 }}>
            Optional. Fund the commit treasury so MagicBlock can back up the index later.
          </p>
          <p className="hf-mono">{treasury}</p>
          <div className="hf-tools-actions">
            <button
              type="button"
              className="hf-btn hf-btn-ghost hf-btn-sm"
              onClick={() => {
                void navigator.clipboard?.writeText(treasury).then(() => {
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1400);
                });
              }}
            >
              {copied ? "Copied" : "Copy address"}
            </button>
            {canPost && (
              <button
                type="button"
                className="hf-btn hf-btn-ghost hf-btn-sm"
                disabled={Boolean(busy)}
                onClick={() =>
                  void run("Funding treasury", async (w) => {
                    await sendForumTransaction({
                      connection: conn,
                      routerUrl: props.routerUrl,
                      wallet: w,
                      instructions: [fundTreasuryIx(w.publicKey, new PublicKey(treasury), 2_000_000)],
                    });
                  })
                }
              >
                {busy === "Funding treasury" ? busy : "Send 0.002 SOL"}
              </button>
            )}
            <button
              type="button"
              className="hf-btn hf-btn-ghost hf-btn-sm"
              disabled={Boolean(busy)}
              onClick={() =>
                void run("Committing index", async (w) => {
                  const extras: PublicKey[] = [];
                  if (forum.postCount > 0) {
                    extras.push(
                      postPagePda(programId, reader!.forum, pageIndexForPost(forum.postCount - 1))
                    );
                  }
                  if (forum.commentCount > 0) {
                    extras.push(
                      commentPagePda(
                        programId,
                        reader!.forum,
                        pageIndexForComment(forum.commentCount - 1)
                      )
                    );
                  }
                  await sendForumTransaction({
                    connection: conn,
                    routerUrl: props.routerUrl,
                    wallet: w,
                    instructions: [maybeCommitIx(keys!, w.publicKey, validator, extras)],
                  });
                })
              }
            >
              {busy === "Committing index" ? busy : "Backup index"}
            </button>
          </div>
        </div>
      </details>
    </div>
  );
}
