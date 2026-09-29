"use client";

import { useLayoutEffect, useRef, type RefObject } from "react";
import { cn } from "@/lib/utils";

/* ─────────────────────────────────────────────────────────
 * PROMPT BAR (adapted from beautifului.dev — composer only)
 * A soft field whose input grows with the text up to a compact
 * maximum. Enter sends, Shift+Enter adds a line, and the send
 * button fills in only when there is something to send.
 * ───────────────────────────────────────────────────────── */

const MIN_HEIGHT = 40;
const MAX_HEIGHT = 112;

export default function PromptBar({
  value,
  onChange,
  onSubmit,
  canSend,
  disabled = false,
  placeholder,
  label,
  describedBy,
  maxLength,
  inputRef,
  sendLabel = "Send",
}: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  canSend: boolean;
  disabled?: boolean;
  placeholder: string;
  label: string;
  describedBy?: string;
  maxLength?: number;
  inputRef?: RefObject<HTMLTextAreaElement | null>;
  sendLabel?: string;
}) {
  const ownRef = useRef<HTMLTextAreaElement>(null);
  const ref = inputRef ?? ownRef;

  useLayoutEffect(() => {
    const input = ref.current;
    if (!input) return;
    input.style.height = "0px";
    const contentHeight = input.scrollHeight;
    input.style.height = `${Math.min(Math.max(contentHeight, MIN_HEIGHT), MAX_HEIGHT)}px`;
    input.style.overflowY = contentHeight > MAX_HEIGHT ? "auto" : "hidden";
  }, [value, ref]);

  return (
    <form
      onSubmit={(event) => { event.preventDefault(); if (canSend) onSubmit(); }}
      onClick={() => ref.current?.focus()}
      className="flex cursor-text flex-col gap-2 rounded-control border border-line bg-field p-2.5 shadow-[0_1px_2px_rgba(0,0,0,0.035)] transition-[border-color,box-shadow] duration-150 focus-within:border-line-strong"
    >
      <textarea
        ref={ref}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            if (canSend) onSubmit();
          }
        }}
        rows={1}
        maxLength={maxLength}
        placeholder={placeholder}
        aria-label={label}
        aria-describedby={describedBy}
        disabled={disabled}
        className="dashboard-scrollbar resize-none bg-transparent text-[13px] leading-[1.45] text-ink outline-none placeholder:text-ink-3 disabled:opacity-60"
      />
      <div className="flex items-center justify-end">
        <button
          type="submit"
          aria-label={sendLabel}
          disabled={!canSend}
          className={cn(
            "flex size-7 items-center justify-center rounded-[8px] transition-[background-color,color,transform] duration-200 enabled:active:scale-[0.96]",
            canSend ? "bg-ink text-canvas" : "bg-line-strong text-ink-2",
          )}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M12 19V5M5 12l7-7 7 7" />
          </svg>
        </button>
      </div>
    </form>
  );
}
