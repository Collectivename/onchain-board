import { TITLE_MAX } from "./constants";

/** Soft categories — encoded in the on-chain title prefix (no program change). */
export type ForumCategory = "general" | "proposal";

export const FORUM_CATEGORIES: Array<{
  id: ForumCategory;
  label: string;
  short: string;
  blurb: string;
}> = [
  {
    id: "general",
    label: "General",
    short: "Chat",
    blurb: "Community banter, ecosystem talk, open discussion",
  },
  {
    id: "proposal",
    label: "Proposals",
    short: "DAO",
    blurb: "Governance ideas, feedback, proposal discussion",
  },
];

const PREFIX: Record<ForumCategory, string> = {
  general: "G|",
  proposal: "P|",
};

function clipUtf8(value: string, maxBytes: number): string {
  const enc = new TextEncoder();
  if (enc.encode(value).length <= maxBytes) return value;
  let out = "";
  for (const ch of value) {
    const next = out + ch;
    if (enc.encode(next).length > maxBytes) break;
    out = next;
  }
  return out;
}

export function postTitleByteLength(category: ForumCategory, title: string): number {
  const p = PREFIX[category];
  const body = title.trim().replace(/^\s*[GP]\|/i, "");
  return new TextEncoder().encode(`${p}${body}`).length;
}

export function encodePostTitle(category: ForumCategory, title: string): string {
  const p = PREFIX[category];
  const body = title.trim().replace(/^\s*[GP]\|/i, "");
  return clipUtf8(`${p}${body}`, TITLE_MAX);
}

export function parsePostTitle(raw: string): { category: ForumCategory; title: string } {
  const s = raw.trim();
  if (/^P\|/i.test(s)) return { category: "proposal", title: s.slice(2).trim() };
  if (/^G\|/i.test(s)) return { category: "general", title: s.slice(2).trim() };
  return { category: "general", title: s };
}
