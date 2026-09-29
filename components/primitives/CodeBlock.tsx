"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";

/* ─────────────────────────────────────────────────────────
 * CODE BLOCK (adapted from beautifului.dev — Code view)
 * A light editor panel: file name, copy action, and a
 * line-numbered listing with light syntax colouring.
 * ───────────────────────────────────────────────────────── */

const KEYWORDS = new Set(["import", "from", "export", "default", "async", "function", "const", "let", "var", "await", "return", "if", "else", "for", "while", "new", "throw", "try", "catch", "null", "true", "false", "undefined"]);
const TOKEN = /("(?:\\.|[^"\\])*"(?=\s*:)|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`[^`]*`|\b\d+(?:\.\d+)?\b|\b(?:import|from|export|default|async|function|const|let|var|await|return|if|else|for|while|new|throw|try|catch|null|true|false|undefined)\b|[A-Za-z_$][\w$]*(?=\s*\())/g;

function highlight(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let last = 0;
  let k = 0;
  for (const match of text.matchAll(TOKEN)) {
    const index = match.index ?? 0;
    const token = match[0];
    if (index > last) nodes.push(<span key={k++}>{text.slice(last, index)}</span>);
    const isKey = token.startsWith("\"") && /^\s*:/.test(text.slice(index + token.length));
    const style = isKey
      ? { color: "var(--ink)", fontWeight: 500 }
      : /^["'`]/.test(token) || /^\d/.test(token)
        ? { color: "var(--orange)" }
        : KEYWORDS.has(token)
          ? { color: "var(--accent-ink)" }
          : { color: "var(--ink)", fontWeight: 500 };
    nodes.push(<span key={k++} style={style}>{token}</span>);
    last = index + token.length;
  }
  if (last < text.length) nodes.push(<span key={k++}>{text.slice(last)}</span>);
  return nodes;
}

function FileIcon() {
  return (
    <svg aria-hidden width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-ink-3">
      <path d="M17.25 6.75 22.5 12l-5.25 5.25m-10.5 0L1.5 12l5.25-5.25m7.5-3-4.5 16.5" />
    </svg>
  );
}

export default function CodeBlock({
  code,
  filename,
  maxHeight = 360,
  className,
}: {
  code: string;
  filename: string;
  /** Long listings scroll inside the block past this height (px). */
  maxHeight?: number;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  const resetTimer = useRef<number | null>(null);
  const lines = code.split("\n");

  useEffect(() => () => {
    if (resetTimer.current !== null) window.clearTimeout(resetTimer.current);
  }, []);

  const copy = useCallback(() => {
    void navigator.clipboard.writeText(code).then(() => {
      setCopied(true);
      if (resetTimer.current !== null) window.clearTimeout(resetTimer.current);
      resetTimer.current = window.setTimeout(() => setCopied(false), 1500);
    });
  }, [code]);

  return (
    <div className={cn("w-full overflow-hidden rounded-card bg-surface shadow-card", className)}>
      <div className="flex h-10 items-center gap-2 border-b border-line px-3.5 text-[12.5px]">
        <span className="inline-flex min-w-0 items-center gap-[7px]">
          <FileIcon />
          <span className="truncate font-mono leading-none text-ink">{filename}</span>
        </span>
        <button
          type="button"
          aria-label={`Copy ${filename}`}
          onClick={copy}
          className={cn("-mr-1 ml-auto flex h-6 items-center gap-1 rounded-[6px] px-1.5 text-[12px] font-medium transition-colors duration-100 hover:bg-hover", copied ? "text-green" : "text-ink-3 hover:text-ink")}
        >
          {copied ? (
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M20 6L9 17l-5-5" /></svg>
          ) : (
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="9" y="9" width="12" height="12" rx="2.5" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg>
          )}
          {copied ? "Copied" : "Copy"}
        </button>
        <span className="sr-only" role="status" aria-live="polite">{copied ? "Copied" : ""}</span>
      </div>
      <div className="dashboard-scrollbar overflow-y-auto py-3 font-mono text-[12px] leading-[1.65] text-ink-2" style={{ maxHeight }}>
        <div className="relative">
          <span className="pointer-events-none absolute inset-y-0 left-7 w-px bg-line" aria-hidden="true" />
          {lines.map((line, index) => (
            <div key={index} className="grid grid-cols-[28px_minmax(0,1fr)] items-start">
              <span className="select-none text-center text-[11px] text-ink-3" aria-hidden="true">{index + 1}</span>
              <code className="pr-3 pl-2 break-words whitespace-pre-wrap">{highlight(line)}</code>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
