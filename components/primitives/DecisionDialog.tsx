"use client";

import { useRef, useState, type ReactNode } from "react";
import { Button } from "@/components/atoms/Button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { cn, titleCase } from "@/lib/utils";

/* ─────────────────────────────────────────────────────────
 * DECISION DIALOG (human-in-the-loop overlays)
 * The card holds its shape: the title is the question, the
 * body stays compact, and the footer shows a status label with
 * one primary action. Other actions live in an "Alternatives"
 * drawer; picking one promotes it to the primary action, and
 * any input it needs appears above the footer.
 *
 *   <DecisionDialog open onOpenChange>
 *     <DecisionBody title="Approve Web Search">…</DecisionBody>
 *     <DecisionFooter status={…} options={[…]} />
 *   </DecisionDialog>
 * ───────────────────────────────────────────────────────── */

export type DecisionTone = "attention" | "positive" | "negative" | "neutral";

export type DecisionStatus = { label: string; tone?: DecisionTone };

export type DecisionOption = {
  key: string;
  /** Button text while this option is the one to confirm. */
  cta: string;
  /** Row text in the alternatives drawer. */
  short: string;
  /** Right-aligned note in the drawer row (e.g. a consequence). */
  hint?: string;
  danger?: boolean;
  /** Input this option needs, shown above the footer while it is selected. */
  detail?: ReactNode;
  disabled?: boolean;
  /** Submit the surrounding form instead of calling onConfirm. */
  submit?: boolean;
  onConfirm?: () => void;
};

/** Leaves the request pending so the analyst can decide later. */
export function skipForNowOption(onSkip: () => void, disabled?: boolean): DecisionOption {
  return { key: "skip", cta: "Skip for Now", short: "Skip for Now", hint: "Decide Later", disabled, onConfirm: onSkip };
}

const TONE_DOT: Record<DecisionTone, string> = {
  attention: "bg-orange",
  positive: "bg-green",
  negative: "bg-red",
  neutral: "bg-ink-3",
};

const SIZE: Record<"sm" | "md" | "lg", string> = {
  sm: "sm:max-w-md",
  md: "sm:max-w-xl",
  lg: "sm:max-w-2xl",
};

const DRAWER_EASE = "cubic-bezier(0.16, 1, 0.3, 1)";
const DRAWER_MS = 300;

export function DecisionDialog({
  open,
  onOpenChange,
  size = "md",
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  size?: keyof typeof SIZE;
  children: ReactNode;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={cn("max-h-[90vh] grid-rows-[minmax(0,1fr)_auto] gap-0 overflow-hidden rounded-card p-0", SIZE[size])}>
        {children}
      </DialogContent>
    </Dialog>
  );
}

export function DecisionBody({
  title,
  description,
  descriptionHidden = false,
  children,
}: {
  /** The question being asked. Plain strings (often from agent payloads) are shown in Title Case. */
  title: ReactNode;
  /** Short context under the question. Hidden descriptions still label the dialog for screen readers. */
  description?: ReactNode;
  descriptionHidden?: boolean;
  children?: ReactNode;
}) {
  return (
    <div data-decision-body className="dashboard-scrollbar min-h-0 overflow-y-auto px-5 pt-5 pb-4 [mask-image:linear-gradient(to_bottom,transparent,black_16px,black_calc(100%-16px),transparent)]">
      <DialogTitle className="pr-8 text-[15px] font-medium leading-6 text-ink">{typeof title === "string" ? titleCase(title) : title}</DialogTitle>
      <DialogDescription className={descriptionHidden || !description ? "sr-only" : "mt-1 text-[13px] leading-5 text-ink-2"}>
        {description ?? title}
      </DialogDescription>
      {children && <div className="mt-4 flex flex-col gap-4 text-[13px] leading-5 text-ink-2">{children}</div>}
    </div>
  );
}

/** The "Other Options" drawer behind an Alternatives button; shared by decision overlays and inline question cards. */
export function AlternativesDrawer({
  open,
  options,
  disabled = false,
  onChoose,
}: {
  open: boolean;
  options: DecisionOption[];
  disabled?: boolean;
  onChoose: (option: DecisionOption) => void;
}) {
  if (options.length === 0) return null;
  return (
    <div
      className="grid transition-[grid-template-rows,opacity]"
      style={{ gridTemplateRows: open ? "1fr" : "0fr", opacity: open ? 1 : 0, transitionDuration: `${DRAWER_MS}ms`, transitionTimingFunction: DRAWER_EASE }}
      inert={!open}
    >
      <div className="overflow-hidden">
        <div className="border-t border-line px-3 py-2">
          <p className="px-2 pb-1 text-[11px] font-medium text-ink-3">Other Options</p>
          {options.map((option) => (
            <button
              key={option.key}
              type="button"
              disabled={disabled}
              onClick={() => onChoose(option)}
              className="flex w-full items-center gap-2.5 rounded-control px-2 py-1.5 text-left transition-colors duration-100 hover:bg-hover disabled:opacity-50"
            >
              <span className={cn("size-1.5 shrink-0 rounded-full", option.danger ? "bg-red" : "bg-line-strong")} aria-hidden="true" />
              <span className={cn("min-w-0 flex-1 truncate text-[13px]", option.danger ? "text-red" : "text-ink")}>{option.short}</span>
              {option.hint && <span className="shrink-0 text-[11px] text-ink-3">{option.hint}</span>}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

export function DecisionFooter({
  status,
  options,
  submitting = false,
  submittingLabel = "Submitting…",
  initialKey = null,
}: {
  status: DecisionStatus;
  options: DecisionOption[];
  /** Option to start on instead of the first one (e.g. when the analyst chose it elsewhere). */
  initialKey?: string | null;
  submitting?: boolean;
  submittingLabel?: string;
}) {
  const [selectedKey, setSelectedKey] = useState<string | null>(initialKey);
  const [open, setOpen] = useState(false);
  const ctaRef = useRef<HTMLButtonElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  const active = options.find((option) => option.key === selectedKey) ?? options[0];
  const others = options.filter((option) => option !== active);

  const choose = (option: DecisionOption) => {
    setSelectedKey(option.key);
    setOpen(false);
    if (!option.detail) {
      requestAnimationFrame(() => ctaRef.current?.focus());
      return;
    }
    // The detail takes room from the body on short screens; keep the content right above it in view.
    // Wait for the drawer to finish closing so the scroll lands on the final layout.
    window.setTimeout(() => {
      const body = rootRef.current?.parentElement?.querySelector<HTMLElement>("[data-decision-body]");
      body?.scrollTo({ top: body.scrollHeight, behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
    }, DRAWER_MS);
  };

  return (
    <div ref={rootRef} className="flex flex-col">
      {active?.detail && (
        <div key={active.key} className="border-t border-line px-5 py-4" style={{ animation: "fade-in 180ms ease-out both" }}>
          {active.detail}
        </div>
      )}

      <AlternativesDrawer open={open} options={others} disabled={submitting} onChoose={choose} />

      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 border-t border-line px-5 py-3">
        <span className="flex min-w-0 items-center gap-2">
          <span className={cn("size-1.5 shrink-0 rounded-full", TONE_DOT[status.tone ?? "attention"])} aria-hidden="true" />
          <span className="truncate text-[12.5px] font-medium text-ink-2">{status.label}</span>
        </span>
        <span className="-mr-0.5 ml-auto flex shrink-0 items-center gap-2">
          {others.length > 0 && (
            <Button
              type="button"
              variant="secondary"
              size="sm"
              aria-expanded={open}
              disabled={submitting}
              onClick={() => setOpen((current) => !current)}
            >
              Alternatives
            </Button>
          )}
          {active && (
            <Button
              ref={ctaRef}
              type={active.submit ? "submit" : "button"}
              variant={active.danger ? "danger" : "primary"}
              size="sm"
              disabled={submitting || active.disabled}
              onClick={active.submit ? undefined : active.onConfirm}
            >
              {submitting ? submittingLabel : active.cta}
            </Button>
          )}
        </span>
      </div>
      <span className="sr-only" role="status" aria-live="polite">{submitting ? submittingLabel : ""}</span>
    </div>
  );
}
