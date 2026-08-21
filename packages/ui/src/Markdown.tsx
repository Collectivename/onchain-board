import { Fragment, type ReactNode } from "react";

/**
 * Sanitized Markdown: never dangerouslySetInnerHTML. Links are http(s) only.
 */

const MAX_LINK_LEN = 2048;

function safeHref(url: string): string | null {
  if (url.length > MAX_LINK_LEN) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:"
      ? parsed.toString()
      : null;
  } catch {
    return null;
  }
}

function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const pattern =
    /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\*[^*\n]+\*)|(\[[^\]\n]*\]\([^)\s]+\))/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;

  while ((m = pattern.exec(text)) !== null) {
    if (m.index > last) nodes.push(text.slice(last, m.index));
    const token = m[0];
    const key = `${keyPrefix}-i${i++}`;

    if (token.startsWith("`")) {
      nodes.push(
        <code key={key} className="hf-code">
          {token.slice(1, -1)}
        </code>
      );
    } else if (token.startsWith("**")) {
      nodes.push(<strong key={key}>{token.slice(2, -2)}</strong>);
    } else if (token.startsWith("*")) {
      nodes.push(<em key={key}>{token.slice(1, -1)}</em>);
    } else {
      const split = token.indexOf("](");
      const label = token.slice(1, split);
      const href = safeHref(token.slice(split + 2, -1));
      nodes.push(
        href ? (
          <a key={key} href={href} target="_blank" rel="noopener noreferrer nofollow ugc">
            {label || href}
          </a>
        ) : (
          <Fragment key={key}>{token}</Fragment>
        )
      );
    }
    last = m.index + token.length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

type Block =
  | { type: "p" | "h1" | "h2" | "h3" | "quote"; lines: string[] }
  | { type: "ul" | "ol"; items: string[] }
  | { type: "hr" };

function parseBlocks(src: string): Block[] {
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let para: string[] = [];

  const flushPara = () => {
    if (para.length) {
      blocks.push({ type: "p", lines: para });
      para = [];
    }
  };

  for (const line of lines) {
    const t = line.trim();
    if (!t) {
      flushPara();
      continue;
    }
    if (/^---+$/.test(t)) {
      flushPara();
      blocks.push({ type: "hr" });
      continue;
    }
    const heading = /^(#{1,3})\s+(.*)$/.exec(t);
    if (heading) {
      flushPara();
      const level = heading[1].length;
      blocks.push({
        type: level === 1 ? "h1" : level === 2 ? "h2" : "h3",
        lines: [heading[2]],
      });
      continue;
    }
    const bullet = /^[-*]\s+(.*)$/.exec(t);
    if (bullet) {
      flushPara();
      const prev = blocks[blocks.length - 1];
      if (prev && prev.type === "ul") prev.items.push(bullet[1]);
      else blocks.push({ type: "ul", items: [bullet[1]] });
      continue;
    }
    const numbered = /^\d+[.)]\s+(.*)$/.exec(t);
    if (numbered) {
      flushPara();
      const prev = blocks[blocks.length - 1];
      if (prev && prev.type === "ol") prev.items.push(numbered[1]);
      else blocks.push({ type: "ol", items: [numbered[1]] });
      continue;
    }
    const quote = /^>\s?(.*)$/.exec(t);
    if (quote) {
      flushPara();
      const prev = blocks[blocks.length - 1];
      if (prev && prev.type === "quote") prev.lines.push(quote[1]);
      else blocks.push({ type: "quote", lines: [quote[1]] });
      continue;
    }
    para.push(t);
  }
  flushPara();
  return blocks;
}

export function Markdown({ children, className = "" }: { children: string; className?: string }) {
  const blocks = parseBlocks(children);
  return (
    <div className={`hf-md ${className}`}>
      {blocks.map((b, i) => {
        const key = `b${i}`;
        switch (b.type) {
          case "hr":
            return <hr key={key} />;
          case "h1":
            return <h4 key={key}>{renderInline(b.lines[0], key)}</h4>;
          case "h2":
            return <h5 key={key}>{renderInline(b.lines[0], key)}</h5>;
          case "h3":
            return <h6 key={key}>{renderInline(b.lines[0], key)}</h6>;
          case "quote":
            return (
              <blockquote key={key}>
                {b.lines.map((l, j) => (
                  <p key={j}>{renderInline(l, `${key}-${j}`)}</p>
                ))}
              </blockquote>
            );
          case "ul":
            return (
              <ul key={key}>
                {b.items.map((it, j) => (
                  <li key={j}>{renderInline(it, `${key}-${j}`)}</li>
                ))}
              </ul>
            );
          case "ol":
            return (
              <ol key={key}>
                {b.items.map((it, j) => (
                  <li key={j}>{renderInline(it, `${key}-${j}`)}</li>
                ))}
              </ol>
            );
          default:
            return (
              <p key={key}>
                {b.lines.map((l, j) => (
                  <Fragment key={j}>
                    {j > 0 && <br />}
                    {renderInline(l, `${key}-${j}`)}
                  </Fragment>
                ))}
              </p>
            );
        }
      })}
    </div>
  );
}
