"use client";

import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Button } from "@/components/atoms/Button";
import { Textarea } from "@/components/ui/textarea";
import GlideMenu from "@/components/primitives/GlideMenu";
import { AlternativesDrawer, type DecisionOption } from "@/components/primitives/DecisionDialog";
import { SourceChip } from "@/components/primitives/ContextCards";
import { SourceExcerpt } from "@/components/ui/source-text";
import { formatSourceExcerpt } from "@/lib/source-excerpt";

/* ─────────────────────────────────────────────────────────
 * APPROVAL CARD (human-in-the-loop)
 * One question at a time. The stack slides vertically as you
 * move between questions (the card's height animates to fit),
 * the step counter rolls like an odometer, and the footer uses
 * pill actions — a quiet Skip and a Continue / Send.
 * Questions and options come from the caller (e.g. an agent's
 * checkpoint payload). Single-choice answers auto-advance to the
 * next question; sending always needs an explicit click.
 * ───────────────────────────────────────────────────────── */

/** One source behind an option: where it is, the date the value applied (YYYY-MM-DD) and the exact quote. */
export type ApprovalOptionSource = {
  asOf: string | null;
  excerpt: string | null;
  /** Shown as a chip, which opens the source when `onView` is set. */
  name?: string;
  kind?: string;
  onView?: () => void;
};

/** Where one option comes from, so it can be judged without opening the document. */
export type ApprovalOptionDetail = {
  sources: ApprovalOptionSource[];
  /** The caller's suggested option; it is marked, never preselected. */
  suggested?: boolean;
};

export type ApprovalQuestion = {
  id?: string;
  q: string;
  type: "radio" | "check";
  options: string[];
  /** Optional, index-aligned with `options`. */
  optionDetails?: ApprovalOptionDetail[];
  /** The options are competing values of one fact: the words that set each apart are emphasized. */
  compareOptions?: boolean;
  /** Show the free-text row. Defaults to true, and is forced on when there are no options. */
  allowCustom?: boolean;
  /** Optional questions can be skipped; required ones must be answered before sending. */
  optional?: boolean;
};

export type ApprovalResult = {
  /** Selected option indices per question index. */
  selections: Record<number, number[]>;
  /** Trimmed free-text answer per question index (omitted when empty). */
  custom: Record<number, string>;
};

export type ApprovalLabels = {
  skip: string;
  continue: string;
  send: string;
  sending: string;
  customPlaceholder: string;
  answerPlaceholder: string;
  sentMessage: string;
};

const DEFAULT_LABELS: ApprovalLabels = {
  skip: "Skip",
  continue: "Continue",
  send: "Send",
  sending: "Sending…",
  customPlaceholder: "Something else…",
  answerPlaceholder: "Type your answer…",
  sentMessage: "Answers sent",
};

const ROLL_MS = 400;
/* room kept around the active question inside the clipping viewport, so a field's border,
   shadow or focus ring at the edge is never shaved; smaller than the gap between questions */
const CLIP_BLEED = 4;
const SLIDE = "360ms cubic-bezier(0.22, 1, 0.36, 1)";

/* odometer digits — each character that changes rolls up (or down) */
function RollingDigits({ value }: { value: string }) {
  const prevRef = useRef(value);
  const [oldVal, setOldVal] = useState(value);
  const [newVal, setNewVal] = useState(value);
  const [rolling, setRolling] = useState(false);
  const [shifted, setShifted] = useState(false);
  const [dir, setDir] = useState<"up" | "down">("up");

  useEffect(() => {
    if (prevRef.current === value) return;
    const from = prevRef.current;
    prevRef.current = value;
    const fromN = parseInt(from, 10);
    const toN = parseInt(value, 10);
    setDir(Number.isFinite(fromN) && Number.isFinite(toN) && toN < fromN ? "down" : "up");
    setOldVal(from);
    setNewVal(value);
    setRolling(true);
    setShifted(false);

    let raf2 = 0;
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => setShifted(true));
    });
    const done = setTimeout(() => {
      setRolling(false);
      setOldVal(value);
      setShifted(false);
    }, ROLL_MS);

    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
      clearTimeout(done);
    };
  }, [value]);

  const chars = rolling ? newVal : oldVal;

  return (
    <>
      {Array.from({ length: chars.length }, (_, i) => {
        const o = oldVal[i] ?? "";
        const n = chars[i] ?? "";
        if (!rolling || o === n) {
          return <span key={`${i}-${n}`}>{n}</span>;
        }
        const top = dir === "down" ? n : o;
        const bottom = dir === "down" ? o : n;
        const restY = dir === "down" ? "0" : "-1em";
        const startY = dir === "down" ? "-1em" : "0";
        return (
          <span
            key={`${i}-${o}-${n}-${dir}`}
            style={{ display: "inline-block", position: "relative", overflow: "hidden", height: "1em", lineHeight: "1em", verticalAlign: "-0.05em" }}
          >
            <span
              style={{
                display: "flex",
                flexDirection: "column",
                transition: "transform 350ms cubic-bezier(0.4, 0, 0.2, 1)",
                transform: `translateY(${shifted ? restY : startY})`,
              }}
            >
              <span style={{ height: "1em", lineHeight: "1em" }}>{top}</span>
              <span style={{ height: "1em", lineHeight: "1em" }}>{bottom}</span>
            </span>
          </span>
        );
      })}
    </>
  );
}

function Ico({ path, size = 14, sw = 2 }: { path: React.ReactNode; size?: number; sw?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {path}
    </svg>
  );
}

/* a source date is a calendar day, so it is shown in UTC to avoid slipping a day in western time zones */
const formatSourceDate = (value: string) => {
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
};

const comparable = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

function OptionSources({ option, detail }: { option: string; detail: ApprovalOptionDetail }) {
  // One chip per named source; several passages from one document share it.
  const chips = detail.sources.filter((source, i) =>
    source.name && detail.sources.findIndex((other) => other.name === source.name) === i);
  // A quote that only repeats the option adds nothing; its chip opens the full passage.
  const value = comparable(option);
  const lines = detail.sources
    .map((source) => ({
      asOf: source.asOf,
      excerpt: source.excerpt && !comparable(formatSourceExcerpt(source.excerpt)).includes(value) ? source.excerpt : null,
    }))
    .filter((source) => source.asOf || source.excerpt);
  if (!detail.suggested && !chips.length && !lines.length) return null;
  return (
    <span className="mt-1 flex flex-col gap-1 text-[12px] leading-snug text-ink-3">
      {detail.suggested && <span className="font-medium text-ink-2">Suggested · Most Recent Dated Source</span>}
      {chips.length > 0 && (
        // Above the row's stretched click target, so a chip opens its source instead of picking the option.
        <span className="relative z-10 flex flex-wrap gap-1" role="group" aria-label="Sources">
          {chips.map((source) => (
            <SourceChip
              key={source.name}
              name={source.name!}
              kind={source.kind}
              onClick={source.onView}
              label={source.onView ? `View ${source.name}` : undefined}
            />
          ))}
        </span>
      )}
      {lines.map((source, i) => (
        <span key={i} className="line-clamp-2">
          {source.asOf && <span className="text-ink-2">As of {formatSourceDate(source.asOf)}</span>}
          {source.asOf && source.excerpt && " · "}
          {source.excerpt && <>“<SourceExcerpt>{source.excerpt}</SourceExcerpt>”</>}
        </span>
      ))}
    </span>
  );
}

/* word-level longest common subsequence: which words of `a` also appear, in order, in `b` */
function sharedWords(a: string[], b: string[]): boolean[] {
  const table = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  const shared = new Array<boolean>(a.length).fill(false);
  for (let i = 0, j = 0; i < a.length && j < b.length;) {
    if (a[i] === b[j]) { shared[i] = true; i++; j++; }
    else if (table[i + 1][j] >= table[i][j + 1]) i++;
    else j++;
  }
  return shared;
}

/** Each option split into words, marking the words not shared with every other option. Options with
 *  nothing in common are left plain: emphasizing all of them would point at nothing. */
function optionDifferences(options: string[]): { word: string; differs: boolean }[][] | null {
  const words = options.map((option) => option.split(/(\s+)/).filter(Boolean));
  const marked = words.map((own, i) => {
    const text = own.map((word, k) => ({ word, k })).filter(({ word }) => word.trim());
    const tokens = text.map(({ word }) => word);
    const differs = new Set<number>();
    words.forEach((other, j) => {
      if (i === j) return;
      const shared = sharedWords(tokens, other.filter((word) => word.trim()));
      shared.forEach((isShared, t) => { if (!isShared) differs.add(text[t].k); });
    });
    return own.map((word, k) => ({ word, differs: differs.has(k) }));
  });
  const allWords = marked.flat().filter(({ word }) => word.trim());
  const anyShared = allWords.some(({ differs }) => !differs);
  const anyDiffers = allWords.some(({ differs }) => differs);
  return anyShared && anyDiffers ? marked : null;
}

function OptionText({ words }: { words: { word: string; differs: boolean }[] }) {
  return (
    <>
      {words.map(({ word, differs }, k) => differs
        ? <strong key={k} className="font-semibold text-ink">{word}</strong>
        : word)}
    </>
  );
}

const showsCustom = (question: ApprovalQuestion) => question.allowCustom !== false || question.options.length === 0;

export default function ApprovalCard({
  questions,
  labels,
  onSubmit,
  onAnswerChange,
  resettable = false,
  error,
  label,
  alternatives = [],
  className = "w-full max-w-80",
}: {
  questions: ApprovalQuestion[];
  labels?: Partial<ApprovalLabels>;
  /** Return false (or resolve false) to keep the card open, e.g. when the server rejects the answers. */
  onSubmit?: (result: ApprovalResult) => boolean | void | Promise<boolean | void>;
  onAnswerChange?: (questionIndex: number, answer: number[]) => void;
  resettable?: boolean;
  error?: string | null;
  /** Extra content under the questions, above the footer (e.g. a link to more actions). */
  /** Context shown above the question, e.g. the request title. */
  label?: ReactNode;
  /** Other ways to respond (reject, skip), offered behind an Alternatives button like the decision overlays. */
  alternatives?: DecisionOption[];
  className?: string;
}) {
  const t = { ...DEFAULT_LABELS, ...labels };
  const baseId = useId();
  const [qi, setQi] = useState(0);
  const [answers, setAnswers] = useState<Record<number, number[]>>({});
  const [custom, setCustom] = useState<Record<number, string>>({});
  const [sent, setSent] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [alternativesOpen, setAlternativesOpen] = useState(false);

  const advanceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const questionRefs = useRef<(HTMLDivElement | null)[]>([]);
  const trackRef = useRef<HTMLDivElement | null>(null);
  const appliedSize = useRef<{ top: number; height: number } | null>(null);
  const measured = useRef(false);
  const [viewportH, setViewportH] = useState<number | undefined>(undefined);
  const [trackY, setTrackY] = useState(0);
  const [animate, setAnimate] = useState(false);
  // Until the first question is measured, render only the active one so the
  // initial (and SSR) height is Q1's height — not all questions stacked, which
  // would flash to full height and then shrink on mount.
  const [ready, setReady] = useState(false);

  const last = qi === questions.length - 1;
  const answered = (index: number) => (answers[index] ?? []).length > 0 || Boolean(custom[index]?.trim());
  const hasAnswer = answered(qi);
  const current = questions[qi];

  // Fractional geometry of the active question within the track. offsetTop/offsetHeight round
  // to whole pixels, which lets the clip shave the last pixel of the question.
  const measure = () => {
    const item = questionRefs.current[qi];
    const track = trackRef.current;
    if (!item || !track) return null;
    const box = item.getBoundingClientRect();
    return { top: box.top - track.getBoundingClientRect().top, height: box.height };
  };

  const sync = (withAnim: boolean) => {
    const size = measure();
    if (!size) return;
    appliedSize.current = size;
    const reduce = typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    setViewportH(size.height + CLIP_BLEED * 2);
    setTrackY(size.top);
    setAnimate(withAnim && !reduce);
  };

  useLayoutEffect(() => {
    const withAnim = measured.current;
    measured.current = true;
    sync(withAnim);
    setReady(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qi, sent]);

  // Follow the active question's size however it changes (a growing answer, fonts loading,
  // a narrower window) without animating, so the viewport never lags behind its content.
  useEffect(() => {
    const item = questionRefs.current[qi];
    if (!item || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      const size = measure();
      const applied = appliedSize.current;
      // The observer also fires once on attach; only a real change should cancel the slide.
      if (!size || (applied && Math.abs(size.height - applied.height) < 0.5 && Math.abs(size.top - applied.top) < 0.5)) return;
      appliedSize.current = size;
      setAnimate(false);
      setViewportH(size.height + CLIP_BLEED * 2);
      setTrackY(size.top);
    });
    observer.observe(item);
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qi, ready]);

  useEffect(() => {
    const id = requestAnimationFrame(() => sync(measured.current));
    return () => cancelAnimationFrame(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qi]);

  useEffect(() => () => { if (advanceTimer.current) clearTimeout(advanceTimer.current); }, []);

  if (questions.length === 0) return null;

  const goTo = (next: number) => {
    if (advanceTimer.current) clearTimeout(advanceTimer.current);
    setQi(Math.min(Math.max(next, 0), questions.length - 1));
  };

  const send = async () => {
    if (advanceTimer.current) clearTimeout(advanceTimer.current);
    if (submitting) return;
    const missing = questions.findIndex((question, index) => !question.optional && !answered(index));
    if (missing !== -1) {
      goTo(missing);
      return;
    }
    const trimmed: Record<number, string> = {};
    for (const [index, value] of Object.entries(custom)) {
      if (value.trim()) trimmed[Number(index)] = value.trim();
    }
    setSubmitting(true);
    try {
      const accepted = await onSubmit?.({ selections: answers, custom: trimmed });
      if (accepted !== false) setSent(true);
    } finally {
      setSubmitting(false);
    }
  };

  const advance = () => {
    if (last) void send();
    else goTo(qi + 1);
  };

  const toggle = (index: number) => {
    const type = current.type;
    const picked = answers[qi] ?? [];
    const next = type === "radio"
      ? [index]
      : picked.includes(index)
        ? picked.filter((item) => item !== index)
        : [...picked, index];
    setAnswers((existing) => ({ ...existing, [qi]: next }));
    onAnswerChange?.(qi, next);
    if (type === "radio") {
      setCustom((existing) => ({ ...existing, [qi]: "" }));
      if (advanceTimer.current) clearTimeout(advanceTimer.current);
      // Advance to the next question, but never send without an explicit click.
      if (!last) {
        advanceTimer.current = setTimeout(() => {
          setQi((currentIndex) => Math.min(questions.length - 1, currentIndex + 1));
        }, 480);
      }
    }
  };

  const reset = () => {
    setQi(0);
    setAnswers({});
    setCustom({});
    setSent(false);
    measured.current = false;
  };


  if (sent) {
    return (
      <div className={`flex items-center gap-3 ${className}`} role="status" style={{ animation: "pop-in 260ms cubic-bezier(0.23,1,0.32,1) both" }}>
        <span className="inline-flex items-center gap-1.5 rounded-full bg-green-tint py-1 pr-2.5 pl-1 text-[12.5px] font-medium text-green">
          <span className="flex size-4.5 items-center justify-center rounded-full bg-green text-white">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M20 6L9 17l-5-5" /></svg>
          </span>
          {t.sentMessage}
        </span>
        {resettable && (
          <button type="button" onClick={reset} className="text-[12px] font-medium text-ink-3 transition-colors duration-150 hover:text-ink">
            Start over
          </button>
        )}
      </div>
    );
  }

  return (
    <div className={className}>
      <div className="relative overflow-clip rounded-card bg-surface shadow-card" style={{ animation: "fade-up 380ms cubic-bezier(0.23,1,0.32,1) both" }}>
        <div className="primitive-card-pad">
          {label && <p className="mb-1.5 text-[12px] font-medium text-ink-3">{label}</p>}
          {/* the question itself is the heading; clip (not hidden) so a growing answer
              box can't scroll the viewport and push the question out of view */}
          <div
            className="overflow-clip"
            style={{
              height: viewportH,
              margin: -CLIP_BLEED,
              padding: CLIP_BLEED,
              transition: animate ? `height ${SLIDE}` : undefined,
            }}
            aria-live="polite"
          >
            <div
              ref={trackRef}
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 26,
                transform: `translate3d(0, ${-trackY}px, 0)`,
                transition: animate ? `transform ${SLIDE}` : undefined,
                willChange: "transform",
              }}
            >
              {questions.map((question, qIdx) => {
                const active = qIdx === qi;
                // Before the first measure, mount only the active question so the
                // card opens at its real height instead of flashing to full height.
                if (!ready && !active) return null;
                const picked = answers[qIdx] ?? [];
                const labelId = `${baseId}-q${qIdx}`;
                const differences = question.compareOptions ? optionDifferences(question.options) : null;
                const questionStyle: CSSProperties = {
                  opacity: active ? 1 : 0,
                  transition: animate ? `opacity ${SLIDE}` : undefined,
                  pointerEvents: active ? undefined : "none",
                };
                return (
                  <div
                    key={question.id ?? qIdx}
                    ref={(el) => { questionRefs.current[qIdx] = el; }}
                    aria-hidden={active ? undefined : true}
                    inert={!active}
                    style={questionStyle}
                  >
                    <div id={labelId} className="text-[14px] font-medium text-ink">{question.q}</div>
                    {question.options.length > 0 && (
                      <GlideMenu className="mt-2.5 flex flex-col gap-1" highlightClassName="inset-x-0 rounded-control bg-hover">
                        <div role={question.type === "radio" ? "radiogroup" : "group"} aria-labelledby={labelId} className="contents">
                          {question.options.map((option, i) => {
                            const on = picked.includes(i);
                            const detail = question.optionDetails?.[i];
                            return (
                              // The row is the click target (the button stretches over it), so source
                              // chips inside it can open their documents without nesting buttons.
                              <div
                                key={`${i}-${option}`}
                                data-menu-row
                                className={`relative z-10 flex gap-1.5 rounded-control pl-1 pr-2 py-1 ${detail ? "items-start" : "items-center"}`}
                              >
                                <span
                                  aria-hidden
                                  className={`flex size-4 shrink-0 items-center justify-center transition-colors duration-200 ${detail ? "mt-px" : ""}
                                    ${question.type === "radio" ? "rounded-full" : "rounded-[5px]"}
                                    ${on ? "bg-ink text-canvas" : "shadow-[inset_0_0_0_1.5px_var(--line-strong)] text-transparent"}`}
                                >
                                  {question.type === "radio" ? (
                                    <span className="size-1.5 rounded-full bg-canvas transition-transform duration-200" style={{ transform: on ? "scale(1)" : "scale(0)" }} />
                                  ) : (
                                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M20 6L9 17l-5-5" /></svg>
                                  )}
                                </span>
                                <span className="flex min-w-0 flex-col">
                                  <button
                                    type="button"
                                    role={question.type === "radio" ? "radio" : "checkbox"}
                                    aria-checked={on}
                                    tabIndex={active ? 0 : -1}
                                    disabled={submitting}
                                    onClick={() => { if (active) toggle(i); }}
                                    className={`text-left text-[13px] leading-snug [overflow-wrap:anywhere] transition-colors duration-200 after:absolute after:inset-0 after:rounded-control after:content-[''] ${on ? "text-ink" : "text-ink-2"}`}
                                  >
                                    {differences ? <OptionText words={differences[i]} /> : option}
                                  </button>
                                  {detail && <OptionSources option={option} detail={detail} />}
                                </span>
                              </div>
                            );
                          })}
                        </div>
                      </GlideMenu>
                    )}
                    {showsCustom(question) && (
                      // Free text is always a field (the shared Textarea), never a menu row, so it
                      // reads as an input whether or not the pointer is over it.
                      <Textarea
                        rows={1}
                        value={custom[qIdx] ?? ""}
                        tabIndex={active ? 0 : -1}
                        disabled={submitting}
                        onChange={(event) => {
                          if (!active) return;
                          setCustom((existing) => ({ ...existing, [qIdx]: event.target.value }));
                          if (question.type === "radio") setAnswers((existing) => ({ ...existing, [qIdx]: [] }));
                        }}
                        onKeyDown={(event) => {
                          if (event.key === "Enter" && !event.shiftKey && hasAnswer) {
                            event.preventDefault();
                            advance();
                          }
                        }}
                        placeholder={question.options.length ? t.customPlaceholder : t.answerPlaceholder}
                        aria-label={question.options.length ? "Custom answer" : question.q}
                        className={`max-h-32 text-[13px] leading-snug md:text-[13px] ${question.options.length ? "mt-1.5 min-h-9 py-1.5" : "mt-2.5"}`}
                      />
                    )}
                  </div>
                );
              })}
            </div>
          </div>
          {error && <p role="alert" className="mt-3 text-[12px] text-red">{error}</p>}
        </div>

        <AlternativesDrawer
          open={alternativesOpen}
          options={alternatives}
          disabled={submitting}
          onChoose={(option) => { setAlternativesOpen(false); option.onConfirm?.(); }}
        />

        {/* footer — step nav (rolling counter) + pill actions */}
        <div className="primitive-card-footer flex items-center justify-between gap-3">
          <div className="flex items-center gap-1 text-ink-3">
            {questions.length > 1 && (
              <>
                <button
                  type="button"
                  aria-label="Previous question"
                  disabled={qi <= 0}
                  onClick={() => goTo(qi - 1)}
                  className="flex size-[18px] items-center justify-center rounded-[5px] transition-colors duration-100 enabled:hover:text-ink disabled:opacity-30"
                >
                  <Ico size={14} path={<path d="M18 15l-6-6-6 6" />} />
                </button>
                <span className="inline-flex items-center text-[12px] font-medium tabular-nums text-ink-3" style={{ letterSpacing: "-0.1px", lineHeight: 1 }}>
                  <RollingDigits value={`${qi + 1} / ${questions.length}`} />
                </span>
                <button
                  type="button"
                  aria-label="Next question"
                  disabled={last}
                  onClick={() => goTo(qi + 1)}
                  className="flex size-[18px] items-center justify-center rounded-[5px] transition-colors duration-100 enabled:hover:text-ink disabled:opacity-30"
                >
                  <Ico size={14} path={<path d="M6 9l6 6 6-6" />} />
                </button>
              </>
            )}
          </div>

          <div className="-mr-0.5 flex items-center gap-1.5">
            {current.optional && (
              <Button variant="ghost" size="sm" disabled={submitting} onClick={advance}>
                {t.skip}
              </Button>
            )}
            {alternatives.length > 0 && (
              <Button variant="secondary" size="sm" aria-expanded={alternativesOpen} disabled={submitting} onClick={() => setAlternativesOpen((value) => !value)}>
                Alternatives
              </Button>
            )}
            <Button variant="primary" size="sm" disabled={submitting || !(hasAnswer || current.optional)} onClick={advance}>
              {submitting ? t.sending : last ? t.send : t.continue}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
