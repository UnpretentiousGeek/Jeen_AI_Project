"use client";

import { useEffect, useId, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";

import { cn } from "@/lib/utils";

/* ─────────────────────────────────────────────────────────
 * TASK ROWS (adapted from beautifului.dev)
 * One line per task: a status disc (check, cross, attention, or
 * a ring that spins while the task works), the label, an optional
 * meta value, and a status pill. Rows with a summary or details
 * expand into a dropdown with a guide line.
 *   · "capsules" — separate rounded rows (full-width views)
 *   · "list"     — one card with divided rows (narrow panels)
 * ───────────────────────────────────────────────────────── */

export type TaskRowStatus = "queued" | "working" | "waiting" | "input_required" | "completed" | "failed";

export type TaskDetail = { label: string; value: string };

export type TaskRow = {
  key: string;
  label: string;
  status: TaskRowStatus;
  summary: string | null;
  details: TaskDetail[];
  /** Short value beside the label (e.g. "Optional", "2 Exceptions"). */
  meta?: string;
  /** Step number shown inside the ring for unfinished tasks. */
  step?: number;
  /** Row action when there is nothing to expand (e.g. jump to the task's result). */
  onSelect?: () => void;
  selectLabel?: string;
};

const STATUS_LABEL: Record<TaskRowStatus, string> = {
  queued: "Queued",
  working: "Working",
  waiting: "Waiting",
  input_required: "Needs Input",
  completed: "Completed",
  failed: "Failed",
};

const PILL: Partial<Record<TaskRowStatus, string>> = {
  completed: "bg-green-tint text-green",
  failed: "bg-red-tint text-red",
  input_required: "bg-orange-tint text-orange",
};

const EASE = "cubic-bezier(0.23, 1, 0.32, 1)";

/* Values up to this length sit beside their label; longer prose stacks under it. */
const SHORT_VALUE = 24;

function SpinnerRing({ active, children }: { active: boolean; children?: React.ReactNode }) {
  const size = 22;
  const stroke = 2;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  return (
    <span className="relative inline-flex shrink-0 items-center justify-center" style={{ width: size, height: size }}>
      <svg width={size} height={size} className={cn("absolute inset-0", active && "motion-safe:animate-spin")} style={{ animationDuration: "1.1s" }} aria-hidden="true">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--line)" strokeWidth={stroke} />
        {active && (
          <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--accent)" strokeWidth={stroke} strokeLinecap="round" strokeDasharray={`${c * 0.28} ${c * 0.72}`} />
        )}
      </svg>
      <span className="relative text-[10px] font-semibold tabular-nums text-ink-2">{children}</span>
    </span>
  );
}

function StatusDisc({ row }: { row: TaskRow }) {
  const disc = (tone: string, path: React.ReactNode) => (
    <span className={cn("flex size-5.5 shrink-0 items-center justify-center rounded-full text-white", tone)} aria-hidden="true">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round">{path}</svg>
    </span>
  );
  if (row.status === "completed") return disc("bg-green", <path d="M20 6L9 17l-5-5" />);
  if (row.status === "failed") return disc("bg-red", <path d="M18 6L6 18M6 6l12 12" />);
  if (row.status === "input_required") return disc("bg-orange", <path d="M12 7v6M12 17.5v.01" />);
  return <SpinnerRing active={row.status === "working"}>{row.step}</SpinnerRing>;
}

export default function TaskRows({
  rows,
  variant = "capsules",
  className,
  emptyMessage = "No Agent Activity Has Been Recorded for This Run Yet.",
}: {
  rows: TaskRow[];
  variant?: "capsules" | "list";
  className?: string;
  emptyMessage?: string;
}) {
  const instanceId = useId().replaceAll(":", "");
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [statusAnnouncement, setStatusAnnouncement] = useState("");
  const previousStatuses = useRef<Map<string, TaskRowStatus> | null>(null);
  const announcementTimeout = useRef<number | null>(null);
  const list = variant === "list";

  useEffect(() => {
    const previous = previousStatuses.current;
    if (previous) {
      const changes = rows.filter((row) => previous.has(row.key) && previous.get(row.key) !== row.status);
      if (changes.length > 0) {
        const message = changes.map((row) => `${row.label}: ${STATUS_LABEL[row.status]}`).join(". ");
        setStatusAnnouncement("");
        if (announcementTimeout.current !== null) window.clearTimeout(announcementTimeout.current);
        announcementTimeout.current = window.setTimeout(() => {
          setStatusAnnouncement(message);
          announcementTimeout.current = null;
        }, 50);
      }
    }
    previousStatuses.current = new Map(rows.map((row) => [row.key, row.status]));
  }, [rows]);

  useEffect(() => () => {
    if (announcementTimeout.current !== null) window.clearTimeout(announcementTimeout.current);
  }, []);

  const statusRegion = (
    <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">{statusAnnouncement}</p>
  );

  if (rows.length === 0) {
    return (
      <>
        {statusRegion}
        <p className="rounded-card border border-dashed border-line px-4 py-6 text-center text-sm text-ink-3" role="status" aria-live="polite">{emptyMessage}</p>
      </>
    );
  }

  return (
    <>
      {statusRegion}
      <ul className={cn("flex w-full flex-col", list ? "overflow-hidden rounded-card bg-surface shadow-card" : "gap-2", className)}>
        {rows.map((row, index) => {
          const expandable = Boolean(row.summary) || row.details.length > 0;
          const open = expandable && (expanded[row.key] ?? false);
          const detailsId = `${instanceId}-task-${index}-details`;
          const pill = PILL[row.status];
          const header = (
            <>
              <span className="flex size-6 shrink-0 items-center justify-center">
                <StatusDisc row={row} />
                <span className="sr-only">{STATUS_LABEL[row.status]}: </span>
              </span>
              <span className="flex min-w-0 flex-1 flex-col">
                <span className={cn("truncate text-[13px] font-medium", row.onSelect && !expandable ? "text-ink underline decoration-line-strong underline-offset-4" : "text-ink")}>{row.label}</span>
                {row.summary && !open && !list && <span className="truncate text-[12px] text-ink-3">{row.summary}</span>}
              </span>
              {row.meta && <span className="shrink-0 text-[12px] tabular-nums text-ink-3">{row.meta}</span>}
              {pill && !list && (
                <span className={cn("inline-flex h-5.5 shrink-0 items-center rounded-full px-2 text-[11.5px] font-medium", pill)}>{STATUS_LABEL[row.status]}</span>
              )}
              {expandable && (
                <ChevronDown aria-hidden="true" className={cn("-ml-0.5 size-4 shrink-0 text-ink-3 transition-transform duration-300 motion-reduce:transition-none", open && "rotate-180")} />
              )}
            </>
          );
          const headerClass = cn("flex w-full items-center gap-2.5 px-2.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/40", list ? "min-h-11 py-2" : "min-h-12 py-2");

          return (
            <li
              key={row.key}
              className={cn(
                "overflow-hidden transition-[border-radius,background-color] duration-300 hover:bg-inset",
                list ? "border-b border-line last:border-0" : "bg-surface shadow-card",
              )}
              style={list ? undefined : { borderRadius: open ? 14 : 20 }}
            >
              {expandable ? (
                <button type="button" aria-expanded={open} aria-controls={detailsId} onClick={() => setExpanded((current) => ({ ...current, [row.key]: !open }))} className={headerClass}>
                  {header}
                </button>
              ) : row.onSelect ? (
                <button type="button" onClick={row.onSelect} aria-label={row.selectLabel} className={headerClass}>{header}</button>
              ) : (
                <div className={headerClass}>{header}</div>
              )}

              {expandable && (
                <div
                  id={detailsId}
                  className="grid transition-[grid-template-rows,opacity] duration-300"
                  style={{ gridTemplateRows: open ? "1fr" : "0fr", opacity: open ? 1 : 0, transitionTimingFunction: EASE }}
                  inert={!open}
                >
                  <div className="overflow-hidden">
                    <div className="mb-2.5 grid grid-cols-[24px_minmax(0,1fr)] gap-2.5 px-2.5">
                      <span aria-hidden="true" className="mx-auto h-full w-px bg-line" />
                      <div className="flex min-w-0 flex-col gap-1.5">
                        {row.summary && <p className={cn("whitespace-pre-wrap break-words text-[12.5px] leading-5", row.status === "failed" ? "text-red" : "text-ink-2")}>{row.summary}</p>}
                        {row.details.map((detail) => detail.value.length > SHORT_VALUE ? (
                          <div key={detail.label} className="flex min-w-0 flex-col">
                            <span className="text-[11.5px] text-ink-3">{detail.label}</span>
                            <span className="whitespace-pre-wrap break-words text-[12.5px] leading-5 text-ink-2">{detail.value}</span>
                          </div>
                        ) : (
                          <div key={detail.label} className="flex items-baseline justify-between gap-3">
                            <span className="min-w-0 text-[12px] text-ink-2">{detail.label}</span>
                            <span className="shrink-0 font-mono text-[11.5px] tabular-nums text-ink-3">{detail.value}</span>
                          </div>
                        ))}
                        {row.onSelect && (
                          <button type="button" onClick={row.onSelect} className="self-start text-[12px] font-medium text-ink-2 underline decoration-line-strong underline-offset-4 hover:text-ink">
                            {row.selectLabel ?? "View Result"}
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </>
  );
}
