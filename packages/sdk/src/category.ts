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

export function encodePostTitle(category: ForumCategory, title: string): string {
  const p = PREFIX[category];
  const body = title.trim().replace(/^\s*[GP]\|/i, "");
  return `${p}${body.slice(0, TITLE_MAX - p.length)}`;
}

export function parsePostTitle(raw: string): { category: ForumCategory; title: string } {
  const s = raw.trim();
  if (/^P\|/i.test(s)) return { category: "proposal", title: s.slice(2).trim() };
  if (/^G\|/i.test(s)) return { category: "general", title: s.slice(2).trim() };
  return { category: "general", title: s };
}
