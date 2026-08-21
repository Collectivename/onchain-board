"use client";

import { useCallback, useRef, type RefObject } from "react";
import { Markdown } from "./Markdown";

type Mode = "write" | "preview";

function wrapSelection(
  el: HTMLTextAreaElement,
  before: string,
  after: string = before,
  placeholder = "text"
): { value: string; start: number; end: number } {
  const start = el.selectionStart;
  const end = el.selectionEnd;
  const value = el.value;
  const selected = value.slice(start, end) || placeholder;
  const next = value.slice(0, start) + before + selected + after + value.slice(end);
  const selStart = start + before.length;
  const selEnd = selStart + selected.length;
  return { value: next, start: selStart, end: selEnd };
}

function linePrefix(el: HTMLTextAreaElement, prefix: string): { value: string; start: number; end: number } {
  const start = el.selectionStart;
  const end = el.selectionEnd;
  const value = el.value;
  const lineStart = value.lastIndexOf("\n", start - 1) + 1;
  const lineEndIdx = value.indexOf("\n", end);
  const lineEnd = lineEndIdx === -1 ? value.length : lineEndIdx;
  const block = value.slice(lineStart, lineEnd);
  const lined = block
    .split("\n")
    .map((l) => (l.startsWith(prefix) ? l : `${prefix}${l || "item"}`))
    .join("\n");
  const next = value.slice(0, lineStart) + lined + value.slice(lineEnd);
  return { value: next, start: lineStart, end: lineStart + lined.length };
}

export function MarkdownEditor({
  value,
  onChange,
  placeholder,
  disabled,
  mode,
  onModeChange,
  minRows = 6,
  maxLength,
  bytesLabel,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  disabled?: boolean;
  mode: Mode;
  onModeChange: (m: Mode) => void;
  minRows?: number;
  maxLength?: number;
  bytesLabel?: string;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);

  const apply = useCallback(
    (fn: (el: HTMLTextAreaElement) => { value: string; start: number; end: number }) => {
      const el = ref.current;
      if (!el || disabled) return;
      const next = fn(el);
      onChange(next.value);
      requestAnimationFrame(() => {
        el.focus();
        el.setSelectionRange(next.start, next.end);
      });
    },
    [disabled, onChange]
  );

  const tools: Array<{
    label: string;
    title: string;
    run: (el: HTMLTextAreaElement) => { value: string; start: number; end: number };
  }> = [
    { label: "B", title: "Bold", run: (el) => wrapSelection(el, "**", "**", "bold") },
    { label: "I", title: "Italic", run: (el) => wrapSelection(el, "*", "*", "italic") },
    { label: "H", title: "Heading", run: (el) => linePrefix(el, "## ") },
    { label: "“", title: "Quote", run: (el) => linePrefix(el, "> ") },
    { label: "•", title: "Bullet list", run: (el) => linePrefix(el, "- ") },
    { label: "1.", title: "Numbered list", run: (el) => linePrefix(el, "1. ") },
    { label: "</>", title: "Inline code", run: (el) => wrapSelection(el, "`", "`", "code") },
    {
      label: "[]",
      title: "Link",
      run: (el) => wrapSelection(el, "[", "](https://)", "label"),
    },
  ];

  return (
    <div className={`hf-md-editor${disabled ? " is-disabled" : ""}`}>
      <div className="hf-md-bar">
        <div className="hf-md-modes" role="tablist" aria-label="Editor mode">
          <button
            type="button"
            role="tab"
            aria-selected={mode === "write"}
            className="hf-md-mode"
            onClick={() => onModeChange("write")}
          >
            Write
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === "preview"}
            className="hf-md-mode"
            onClick={() => onModeChange("preview")}
          >
            Preview
          </button>
        </div>
        {mode === "write" && (
          <div className="hf-md-tools" role="toolbar" aria-label="Formatting">
            {tools.map((t) => (
              <button
                key={t.title}
                type="button"
                className="hf-md-tool"
                title={t.title}
                disabled={disabled}
                onClick={() => apply(t.run)}
              >
                {t.label}
              </button>
            ))}
          </div>
        )}
      </div>

      {mode === "write" ? (
        <textarea
          ref={ref as RefObject<HTMLTextAreaElement>}
          className="hf-textarea hf-md-area"
          style={{ minHeight: `${minRows * 1.45}rem` }}
          placeholder={placeholder}
          value={value}
          disabled={disabled}
          maxLength={maxLength}
          onChange={(e) => onChange(e.target.value)}
        />
      ) : (
        <div className="hf-md-preview" aria-live="polite">
          {value.trim() ? (
            <Markdown>{value}</Markdown>
          ) : (
            <p className="hf-muted" style={{ margin: 0 }}>
              Nothing to preview yet.
            </p>
          )}
        </div>
      )}

      {bytesLabel ? <p className="hf-bytes">{bytesLabel}</p> : null}
    </div>
  );
}
