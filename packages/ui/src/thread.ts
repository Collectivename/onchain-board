import type { CommentRecord } from "@holder-forum/sdk";

export type CommentNode = CommentRecord & { children: CommentNode[] };

/** Nest from the on-chain parent only. An HTML hint in the body is display-only. */
export function buildCommentTree(list: CommentRecord[]): CommentNode[] {
  const map = new Map<number, CommentNode>();
  for (const c of list) map.set(c.id, { ...c, children: [] });
  const roots: CommentNode[] = [];
  for (const c of list) {
    const node = map.get(c.id)!;
    if (c.parentCommentId !== 0 && map.has(c.parentCommentId)) {
      map.get(c.parentCommentId)!.children.push(node);
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

/** First caller wins until release. A second click before the next paint does not start another send. */
export function takeBusyLock(lock: { current: boolean }): boolean {
  if (lock.current) return false;
  lock.current = true;
  return true;
}

export function releaseBusyLock(lock: { current: boolean }): void {
  lock.current = false;
}
