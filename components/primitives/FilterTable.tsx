"use client";

import { Fragment, useId, useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import type { StatusTone } from "@/components/primitives/StatusPill";

export { StatusPill, type StatusTone } from "@/components/primitives/StatusPill";

/* ─────────────────────────────────────────────────────────
 * FILTER TABLE (adapted from beautifului.dev)
 * Status chips directly filter the table. Rows that stop
 * matching collapse instead of disappearing, row actions show
 * on hover, and a row can expand to show details underneath.
 * ───────────────────────────────────────────────────────── */

export type FilterChip<K extends string> = { key: K; label: string; count: number; tone?: StatusTone };

export type FilterTableColumn<Row> = {
  key: string;
  header: string;
  /** CSS grid track, e.g. "minmax(0,1.4fr)" or "auto". */
  width: string;
  cell: (row: Row) => ReactNode;
  /** The column that opens the row; renders as the row's accessible button. Exactly one column should set it. */
  primary?: boolean;
  className?: string;
};

const TONE_DOT: Record<StatusTone, string> = {
  todo: "bg-orange",
  progress: "bg-accent",
  done: "bg-green",
  danger: "bg-red",
  neutral: "bg-ink-3",
};

const ROW_EASE = "cubic-bezier(0.23, 1, 0.32, 1)";

export function FilterChips<K extends string>({
  chips,
  active,
  onChange,
  label,
}: {
  chips: FilterChip<K>[];
  active: K;
  onChange: (key: K) => void;
  label: string;
}) {
  return (
    <div role="group" aria-label={label} className="-mx-1 flex items-center gap-1 overflow-x-auto px-1 py-1" style={{ scrollbarWidth: "none" }}>
      {chips.map((chip) => {
        const on = chip.key === active;
        return (
          <button
            key={chip.key}
            type="button"
            aria-pressed={on}
            onClick={() => onChange(chip.key)}
            className={cn(
              "flex h-6.5 shrink-0 items-center gap-1.5 rounded-full px-2.5 text-[12px] font-medium transition-[background-color,box-shadow,color] duration-200",
              on ? "bg-surface text-ink shadow-btn" : "text-ink-2 hover:bg-hover",
            )}
          >
            {chip.tone && <span className={cn("size-1.5 rounded-full", TONE_DOT[chip.tone])} aria-hidden="true" />}
            {chip.label}
            <span className={cn("rounded-[4px] px-1 text-[10.5px] tabular-nums", on ? "bg-field text-ink-2" : "text-ink-3")}>{chip.count}</span>
          </button>
        );
      })}
    </div>
  );
}

export default function FilterTable<Row, K extends string>({
  label,
  rows,
  rowKey,
  rowLabel,
  columns,
  chips,
  activeChip,
  onChipChange,
  matches,
  onOpenRow,
  actions,
  details,
  detailsLabel = (row) => `${rowLabel(row)} details`,
  emptyMessage = "Nothing Matches This Filter.",
  minWidth = 640,
  actionsWidth = 80,
}: {
  label: string;
  rows: Row[];
  rowKey: (row: Row) => string;
  /** Short name of the row, used in accessible labels. */
  rowLabel: (row: Row) => string;
  columns: FilterTableColumn<Row>[];
  chips?: FilterChip<K>[];
  activeChip?: K;
  onChipChange?: (key: K) => void;
  /** Whether a row is shown under the active chip. Rows that do not match collapse. */
  matches?: (row: Row, chip: K) => boolean;
  onOpenRow?: (row: Row) => void;
  /** Row actions, revealed on hover or focus. */
  actions?: (row: Row) => ReactNode;
  /** Expandable detail content; adds a disclosure toggle to each row that returns content. */
  details?: (row: Row) => ReactNode | null;
  detailsLabel?: (row: Row) => string;
  emptyMessage?: string;
  minWidth?: number;
  /** Fixed width of the trailing actions column, so every row shares the same column lines. */
  actionsWidth?: number;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const baseId = useId().replaceAll(":", "");
  const tracks = [...columns.map((column) => column.width), ...(actions || details ? [`${actionsWidth}px`] : [])].join(" ");
  const shown = (row: Row) => !matches || activeChip === undefined || matches(row, activeChip);
  const visibleCount = rows.filter(shown).length;

  const toggle = (key: string) => setExpanded((current) => {
    const next = new Set(current);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    return next;
  });

  return (
    <div className="flex w-full flex-col gap-1">
      {chips && activeChip !== undefined && onChipChange && (
        <FilterChips chips={chips} active={activeChip} onChange={onChipChange} label={`${label} filters`} />
      )}

      <div
        role="region"
        aria-label={label}
        tabIndex={0}
        className="overflow-x-auto rounded-card bg-surface shadow-card outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
        style={{ scrollbarWidth: "none" }}
      >
        <div role="table" aria-label={label} style={{ minWidth }}>
          <div role="row" className="grid border-b border-[var(--grid-line)] text-[12.5px] font-medium text-ink-2" style={{ gridTemplateColumns: tracks }}>
            {columns.map((column, index) => (
              <span
                key={column.key}
                role="columnheader"
                className={cn("px-3 py-2", index < columns.length - 1 && "border-r border-[var(--grid-line)]")}
              >
                {column.header}
              </span>
            ))}
            {(actions || details) && <span role="columnheader" className="px-3 py-2"><span className="sr-only">Actions</span></span>}
          </div>

          {rows.map((row) => {
            const key = rowKey(row);
            const visible = shown(row);
            const detail = details?.(row) ?? null;
            const open = expanded.has(key) && detail !== null;
            const detailsId = `${baseId}-${key}`;
            return (
              <Fragment key={key}>
                <div
                  className="grid transition-[grid-template-rows,opacity] duration-300"
                  style={{ gridTemplateRows: visible ? "1fr" : "0fr", opacity: visible ? 1 : 0, transitionTimingFunction: ROW_EASE }}
                  inert={!visible}
                >
                  <div className="overflow-hidden">
                    <div
                      role="row"
                      className="group/row relative grid border-b border-[var(--grid-line)] text-[13px] transition-colors duration-100 hover:bg-hover"
                      style={{ gridTemplateColumns: tracks }}
                    >
                      {columns.map((column, index) => (
                        <span
                          key={column.key}
                          role="cell"
                          className={cn(
                            "flex min-w-0 items-center px-3 py-2 text-ink-2",
                            index < columns.length - 1 && "border-r border-[var(--grid-line)]",
                            column.className,
                          )}
                        >
                          {column.primary && onOpenRow ? (
                            <button
                              type="button"
                              onClick={() => onOpenRow(row)}
                              className="min-w-0 truncate text-left font-medium text-ink outline-none after:absolute after:inset-0 after:content-[''] focus-visible:after:rounded-control focus-visible:after:ring-2 focus-visible:after:ring-ring/40"
                            >
                              {column.cell(row)}
                            </button>
                          ) : column.cell(row)}
                        </span>
                      ))}
                      {(actions || details) && (
                        <span role="cell" className="relative z-10 flex items-center justify-end gap-0.5 px-2 py-1">
                          {actions && (
                            <span className="flex items-center gap-0.5 transition-opacity duration-150 [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover/row:opacity-100 [@media(hover:hover)]:focus-within:opacity-100">
                              {actions(row)}
                            </span>
                          )}
                          {detail !== null && (
                            <button
                              type="button"
                              aria-expanded={open}
                              aria-controls={detailsId}
                              aria-label={`${open ? "Hide" : "Show"} ${detailsLabel(row)}`}
                              onClick={() => toggle(key)}
                              className="flex size-7 items-center justify-center rounded-control text-ink-3 transition-colors hover:bg-hover-2 hover:text-ink"
                            >
                              <ChevronDown className={cn("size-4 transition-transform duration-200 motion-reduce:transition-none", open && "rotate-180")} aria-hidden="true" />
                            </button>
                          )}
                        </span>
                      )}
                    </div>
                    {detail !== null && (
                      <div role="row" id={detailsId} hidden={!open} className="border-b border-[var(--grid-line)] bg-inset/40 px-4 py-4">
                        <div role="cell">{open && detail}</div>
                      </div>
                    )}
                  </div>
                </div>
              </Fragment>
            );
          })}
          {visibleCount === 0 && <p className="px-3 py-6 text-center text-[13px] text-ink-3">{emptyMessage}</p>}
        </div>
      </div>
    </div>
  );
}
