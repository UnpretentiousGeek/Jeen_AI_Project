"use client";

import { Children, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";

/* ─────────────────────────────────────────────────────────
 * CONTEXT CARDS (adapted from beautifului.dev)
 * A retrieved piece of evidence: a header bar (title + meta),
 * the excerpt, and a source chip with a file-type badge that
 * opens the original.
 * ───────────────────────────────────────────────────────── */

const FILE_BADGES: [RegExp, string, string][] = [
  [/\.pdf$/i, "PDF", "bg-red"],
  [/\.(csv|xlsx?|tsv)$/i, "CSV", "bg-green"],
  [/\.(docx?|rtf|odt)$/i, "DOC", "bg-accent"],
  [/\.(png|jpe?g|gif|webp|tiff?)$/i, "IMG", "bg-orange"],
  [/\.(md|txt)$/i, "TXT", "bg-ink-3"],
];

const KIND_BADGES: Record<string, { badge: string; tone: string }> = {
  policy: { badge: "POL", tone: "bg-accent" },
  external_web: { badge: "WEB", tone: "bg-ink-2" },
  case: { badge: "CASE", tone: "bg-ink-2" },
  finding: { badge: "FND", tone: "bg-green" },
  evidence_gap: { badge: "GAP", tone: "bg-orange" },
  conflict: { badge: "CON", tone: "bg-red" },
  citation: { badge: "CIT", tone: "bg-ink-3" },
};

/** Short file-type badge for a source: by file extension, or by kind for policies and web pages. */
export function sourceBadge(name: string, kind?: string): { badge: string; tone: string } {
  const byKind = KIND_BADGES[kind ?? ""];
  if (byKind) return byKind;
  const match = FILE_BADGES.find(([pattern]) => pattern.test(name));
  return match ? { badge: match[1], tone: match[2] } : { badge: "DOC", tone: "bg-ink-3" };
}

function ArrowIcon() {
  return (
    <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="shrink-0">
      <path d="M7 17L17 7M7 7h10v10" />
    </svg>
  );
}

export function FileBadge({ name, kind, className }: { name: string; kind?: string; className?: string }) {
  const { badge, tone } = sourceBadge(name, kind);
  return (
    <span className={cn("flex h-3.5 min-w-3.5 shrink-0 items-center justify-center rounded-[4px] px-[2px] text-[7px] font-bold text-white", tone, className)} aria-hidden="true">
      {badge}
    </span>
  );
}

/** Pill naming a source; opens it when given `onClick` or `href`. */
export function SourceChip({
  name,
  kind,
  onClick,
  href,
  download,
  label,
  className,
}: {
  name: string;
  kind?: string;
  onClick?: () => void;
  href?: string;
  download?: string;
  /** Accessible name when the visible name is not enough (e.g. adds a locator). */
  label?: string;
  className?: string;
}) {
  const classes = cn(
    "inline-flex h-6 max-w-full items-center gap-1.5 rounded-full bg-inset px-2 text-[12px] font-medium text-ink-2 shadow-btn transition-[background-color,color] duration-150",
    (onClick || href) && "hover:bg-hover hover:text-ink",
    className,
  );
  const content = (
    <>
      <FileBadge name={name} kind={kind} />
      <span className="min-w-0 truncate">{name}</span>
      {(onClick || href) && <ArrowIcon />}
    </>
  );
  if (href) return <a href={href} download={download} aria-label={label} title={name} className={classes}>{content}</a>;
  if (onClick) return <button type="button" onClick={onClick} aria-label={label} title={name} className={classes}>{content}</button>;
  return <span title={name} className={classes}>{content}</span>;
}

/** Card body cut to four lines, with a toggle only when something is actually hidden. */
function ClampedBody({ children, className }: { children: ReactNode; className?: string }) {
  const id = useId();
  const ref = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);

  useEffect(() => {
    const element = ref.current;
    if (!element || expanded) return;
    const measure = () => setOverflowing(element.scrollHeight > element.clientHeight + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [children, expanded]);

  return (
    <div className={cn("px-3 pt-2 pb-1 text-[12.5px] leading-relaxed text-ink-2", className)}>
      <div ref={ref} id={id} className={cn("min-w-0", !expanded && "line-clamp-4")}>{children}</div>
      {overflowing && (
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={id}
          onClick={() => setExpanded((current) => !current)}
          className="mt-1 rounded-control text-xs font-medium text-ink-3 transition-colors hover:text-ink focus-visible:outline-2 focus-visible:outline-accent"
        >
          {expanded ? "Show Less" : "Show More"}
        </button>
      )}
    </div>
  );
}

export function ContextCard({
  title,
  meta,
  children,
  footer,
  className,
}: {
  /** Omitted when the source chip already names the source and there is nothing more specific to say. */
  title?: ReactNode;
  meta?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex min-w-0 flex-col overflow-hidden rounded-card bg-surface shadow-card", className)}>
      {(title || meta) && (
        <div className="primitive-card-bar flex items-center gap-2.5 border-b border-line">
          {title && (
            <span className="flex min-w-0 items-center gap-1.5 text-[13px] font-medium text-ink">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true" className="shrink-0 text-ink-3">
                <path d="M4 6h16M4 12h16M4 18h10" />
              </svg>
              <span className="truncate">{title}</span>
            </span>
          )}
          {meta && <span className="ml-auto flex shrink-0 items-center gap-1 text-[12px] tabular-nums text-ink-3">{meta}</span>}
        </div>
      )}
      {Children.toArray(children).length > 0 && <ClampedBody className={title || meta ? undefined : "pt-3"}>{children}</ClampedBody>}
      {footer && <div className="mt-auto flex min-w-0 items-center gap-2 px-3 pt-1 pb-3">{footer}</div>}
    </div>
  );
}
