"use client";

import { useCallback, useEffect, useId, useRef, useState, type RefObject } from "react";
import {
  Check,
  Clock3,
  Copy,
  MessageSquareText,
  RotateCcw,
  X,
} from "lucide-react";

import { FileBadge } from "@/components/primitives/ContextCards";
import LoadingState from "@/components/primitives/LoadingState";
import PromptBar from "@/components/primitives/PromptBar";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { Markdown } from "@/components/ui/markdown";
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "@/components/ui/message-scroller";
import { titleCase } from "@/lib/utils";
import {
  caseApi,
  type ApiAssistantSource,
  type ApiAssistantTurn,
} from "@/lib/case-api";

const PAGE_SIZE = 20;
const MAX_QUESTION_LENGTH = 2_000;
const PENDING_POLL_MS = 4_000;

type AssistantQuestionKey = {
  caseId: string;
  question: string;
  key: string;
};

type ConversationState = {
  caseId: string;
  turns: ApiAssistantTurn[];
  nextBefore: string | null;
  isLoading: boolean;
  isLoadingOlder: boolean;
  isSending: boolean;
  loadError: string | null;
  olderError: string | null;
  requestError: string | null;
  draft: string;
  announcement: string;
};

function initialConversationState(caseId: string): ConversationState {
  return {
    caseId,
    turns: [],
    nextBefore: null,
    isLoading: false,
    isLoadingOlder: false,
    isSending: false,
    loadError: null,
    olderError: null,
    requestError: null,
    draft: "",
    announcement: "",
  };
}

function compareTurns(left: ApiAssistantTurn, right: ApiAssistantTurn): number {
  const dateOrder = Date.parse(left.created_at) - Date.parse(right.created_at);
  return dateOrder || left.id.localeCompare(right.id);
}

function mergeTurns(...collections: ApiAssistantTurn[][]): ApiAssistantTurn[] {
  const turnsById = new Map<string, ApiAssistantTurn>();
  for (const turn of collections.flat()) turnsById.set(turn.id, turn);
  return [...turnsById.values()].sort(compareTurns);
}

// Keeps older pages the analyst already loaded when the latest page still overlaps them.
function applyLatestPage(
  previous: ConversationState,
  latest: { turns: ApiAssistantTurn[]; next_before: string | null },
): Pick<ConversationState, "turns" | "nextBefore"> {
  const oldestLatest = latest.turns[0];
  const previousIds = new Set(previous.turns.map((turn) => turn.id));
  const overlaps = latest.next_before === null || latest.turns.some((turn) => previousIds.has(turn.id));
  const hasOlderLoaded = oldestLatest !== undefined
    && previous.turns.some((turn) => compareTurns(turn, oldestLatest) < 0);
  if (overlaps && hasOlderLoaded) {
    return { turns: mergeTurns(previous.turns, latest.turns), nextBefore: previous.nextBefore };
  }
  return { turns: latest.turns, nextBefore: latest.next_before };
}

function sourceKindLabel(kind: ApiAssistantSource["kind"]): string {
  return titleCase(kind);
}

function safeExternalUrl(source: ApiAssistantSource): string | null {
  if (source.kind !== "external_web" || !source.url) return null;
  try {
    const url = new URL(source.url);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim() ? error.message : fallback;
}

/* Streaming Text pattern: actions under the answer, then a collapsed, expandable source list. */
function AnswerFooter({ answer, sources }: { answer: string; sources: ApiAssistantSource[] }) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const listId = useId();

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1500);
    return () => window.clearTimeout(timer);
  }, [copied]);

  return (
    <div className="mt-2">
      <div className="flex items-center gap-0.5">
        <button
          type="button"
          aria-label={copied ? "Answer copied" : "Copy answer"}
          onClick={() => { void navigator.clipboard.writeText(answer).then(() => setCopied(true)); }}
          className={`flex size-6 items-center justify-center rounded-[6px] transition-colors duration-100 hover:bg-hover-2 ${copied ? "text-green" : "text-ink-3 hover:text-ink-2"}`}
        >
          {copied ? <Check aria-hidden="true" className="size-[14px]" /> : <Copy aria-hidden="true" className="size-[14px]" />}
        </button>
        {sources.length > 0 && (
          <button
            type="button"
            aria-expanded={open}
            aria-controls={listId}
            onClick={() => setOpen((current) => !current)}
            className="ml-1 flex items-center gap-1.5 rounded-[6px] px-1 py-0.5 text-left transition-colors duration-150 hover:bg-hover"
          >
            <span className="flex -space-x-1">
              {sources.slice(0, 3).map((source) => (
                <FileBadge key={source.id} name={source.title ?? ""} kind={source.kind} className="shadow-[0_0_0_1.5px_var(--surface)]" />
              ))}
            </span>
            <span className="text-[12px] text-ink-2">{sources.length} {sources.length === 1 ? "Source" : "Sources"}</span>
          </button>
        )}
        <span className="sr-only" role="status" aria-live="polite">{copied ? "Answer copied" : ""}</span>
      </div>
      {sources.length > 0 && (
        <div
          id={listId}
          className="grid transition-[grid-template-rows,opacity] duration-300"
          style={{ gridTemplateRows: open ? "1fr" : "0fr", opacity: open ? 1 : 0, transitionTimingFunction: "cubic-bezier(0.23, 1, 0.32, 1)" }}
          inert={!open}
        >
          <div className="overflow-hidden">
            <ul aria-label="Answer sources" className="mt-1.5 flex flex-col rounded-[10px] bg-inset p-1 shadow-hairline">
              {sources.map((source) => {
                const title = source.title?.trim() || sourceKindLabel(source.kind);
                const href = safeExternalUrl(source);
                const content = (
                  <>
                    <FileBadge name={title} kind={source.kind} />
                    <span className="min-w-0 truncate">{title}</span>
                    {source.locator && <span className="ml-auto max-w-[45%] shrink-0 truncate font-mono text-[10.5px] text-ink-3" title={source.locator}>{source.locator}</span>}
                  </>
                );
                return (
                  <li key={source.id}>
                    {href ? (
                      <a href={href} target="_blank" rel="noopener noreferrer" aria-label={`Open ${title} in a new tab`}
                        className="flex items-center gap-2 rounded-[6px] px-1.5 py-1 text-[12px] text-ink-2 transition-colors duration-150 hover:bg-hover hover:text-ink">
                        {content}
                      </a>
                    ) : (
                      <span className="flex items-center gap-2 rounded-[6px] px-1.5 py-1 text-[12px] text-ink-2">{content}</span>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        </div>
      )}
    </div>
  );
}

function AssistantAnswer({ turn }: { turn: ApiAssistantTurn }) {
  if (turn.status === "pending") {
    return (
      <LoadingState label="Working on This Answer…" />
    );
  }

  if (turn.status === "failed") {
    return (
      <Alert variant="warning" className="shadow-none">
        <Clock3 aria-hidden="true" />
        <AlertTitle>Answer Unavailable</AlertTitle>
        <AlertDescription>
          <p>This question could not be completed. You can ask it again below.</p>
        </AlertDescription>
      </Alert>
    );
  }

  return (
    <div className="text-[13px] leading-relaxed text-ink" style={{ animation: "fade-up 400ms cubic-bezier(0.23,1,0.32,1) both" }}>
      <Markdown>{turn.answer || "No answer was returned."}</Markdown>
      <AnswerFooter answer={turn.answer ?? ""} sources={turn.source_refs ?? []} />
    </div>
  );
}

function QuestionBubble({ children }: { children: string }) {
  return (
    <div className="flex justify-end pl-14">
      <div className="whitespace-pre-wrap break-words rounded-xl bg-field px-3 py-1.5 text-[13px] leading-[1.4] text-ink" style={{ animation: "fade-up 300ms cubic-bezier(0.23,1,0.32,1) both" }}>
        {children}
      </div>
    </div>
  );
}

function ConversationTurn({ turn }: { turn: ApiAssistantTurn }) {
  return (
    <div aria-label={`Question: ${turn.question}`} className="flex flex-col gap-2.5">
      <QuestionBubble>{turn.question}</QuestionBubble>
      <AssistantAnswer turn={turn} />
    </div>
  );
}

export function CaseAssistantDialog({
  caseId,
  caseName,
  open,
  onOpenChange,
  triggerRef,
}: {
  caseId: string;
  caseName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  triggerRef: RefObject<HTMLButtonElement | null>;
}) {
  const [conversation, setConversation] = useState<ConversationState>(() => initialConversationState(caseId));
  const generationRef = useRef(0);
  const activeCaseRef = useRef(caseId);
  const openRef = useRef(open);
  const idempotencyRef = useRef<AssistantQuestionKey | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const requestErrorId = useId();

  const current = conversation.caseId === caseId ? conversation : initialConversationState(caseId);

  const isRequestCurrent = useCallback((targetCaseId: string, generation: number) => (
    activeCaseRef.current === targetCaseId
    && generationRef.current === generation
    && openRef.current
  ), []);

  useEffect(() => {
    openRef.current = open;
  }, [open]);

  const refreshLatest = useCallback(async (
    targetCaseId: string,
    generation: number,
    showLoading: boolean,
  ) => {
    if (showLoading) {
      setConversation((previous) => {
        const state = previous.caseId === targetCaseId ? previous : initialConversationState(targetCaseId);
        return { ...state, isLoading: true, loadError: null };
      });
    }

    try {
      const result = await caseApi.getAssistantTurns(targetCaseId, undefined, PAGE_SIZE);
      if (!isRequestCurrent(targetCaseId, generation)) return;
      setConversation((previous) => {
        if (previous.caseId !== targetCaseId) return previous;
        const wasPending = new Set(previous.turns.filter((turn) => turn.status === "pending").map((turn) => turn.id));
        const resolved = result.turns.some((turn) => wasPending.has(turn.id) && turn.status !== "pending");
        return {
          ...previous,
          ...applyLatestPage(previous, result),
          isLoading: false,
          loadError: null,
          announcement: showLoading
            ? result.turns.length > 0 ? "Conversation loaded." : "No questions yet."
            : resolved ? "Answer received." : previous.announcement,
        };
      });
    } catch (error) {
      if (!isRequestCurrent(targetCaseId, generation)) return;
      setConversation((previous) => previous.caseId === targetCaseId
        ? {
            ...previous,
            isLoading: false,
            loadError: errorMessage(error, "Unable to load this conversation."),
          }
        : previous);
    }
  }, [isRequestCurrent]);

  useEffect(() => {
    const caseChanged = activeCaseRef.current !== caseId;
    if (caseChanged) {
      activeCaseRef.current = caseId;
      idempotencyRef.current = null;
      setConversation(initialConversationState(caseId));
    }

    const generation = ++generationRef.current;
    if (!open) {
      setConversation((previous) => previous.caseId === caseId
        ? { ...previous, isLoading: false, isLoadingOlder: false, isSending: false }
        : previous);
      return;
    }

    void refreshLatest(caseId, generation, true);
    return () => {
      if (generationRef.current === generation) generationRef.current += 1;
    };
  }, [caseId, open, refreshLatest]);

  const hasPendingTurn = current.turns.some((turn) => turn.status === "pending");
  const isBusy = current.isLoading || current.isSending;
  useEffect(() => {
    if (!open || !hasPendingTurn || isBusy) return;
    const generation = generationRef.current;
    const timer = window.setTimeout(() => {
      void refreshLatest(caseId, generation, false);
    }, PENDING_POLL_MS);
    return () => window.clearTimeout(timer);
  }, [caseId, open, hasPendingTurn, isBusy, current.turns, refreshLatest]);

  const setPanelOrigin = useCallback((panelNode: HTMLDivElement | null) => {
    if (!panelNode || !triggerRef.current) return;
    const trigger = triggerRef.current.getBoundingClientRect();
    panelNode.style.setProperty("--assistant-enter-x", `${trigger.left + trigger.width / 2 - (panelNode.offsetLeft + panelNode.offsetWidth / 2)}px`);
    panelNode.style.setProperty("--assistant-enter-y", `${trigger.top + trigger.height / 2 - (panelNode.offsetTop + panelNode.offsetHeight / 2)}px`);
  }, [triggerRef]);

  const loadOlder = async () => {
    if (!current.nextBefore || current.isLoadingOlder || !open) return;
    const before = current.nextBefore;
    const generation = generationRef.current;
    setConversation((previous) => previous.caseId === caseId
      ? { ...previous, isLoadingOlder: true, olderError: null }
      : previous);
    try {
      const result = await caseApi.getAssistantTurns(caseId, before, PAGE_SIZE);
      if (!isRequestCurrent(caseId, generation)) return;
      setConversation((previous) => previous.caseId === caseId
        ? {
            ...previous,
            turns: mergeTurns(result.turns, previous.turns),
            nextBefore: result.next_before,
            isLoadingOlder: false,
            olderError: null,
            announcement: result.turns.length > 0 ? "Older questions loaded." : "No older questions found.",
          }
        : previous);
    } catch (error) {
      if (!isRequestCurrent(caseId, generation)) return;
      setConversation((previous) => previous.caseId === caseId
        ? {
            ...previous,
            isLoadingOlder: false,
            olderError: errorMessage(error, "Unable to load older questions."),
          }
        : previous);
    }
  };

  const submitQuestion = async () => {
    const question = current.draft.trim();
    if (!question || current.draft.length > MAX_QUESTION_LENGTH || current.isSending || current.isLoading || !open) return;

    let questionKey = idempotencyRef.current;
    if (!questionKey || questionKey.caseId !== caseId || questionKey.question !== question) {
      questionKey = { caseId, question, key: crypto.randomUUID() };
      idempotencyRef.current = questionKey;
    }

    const generation = generationRef.current;
    setConversation((previous) => previous.caseId === caseId
      ? {
          ...previous,
          isSending: true,
          requestError: null,
          announcement: "Sending your question.",
        }
      : previous);

    try {
      const turn = await caseApi.askAssistant(caseId, {
        question,
        idempotency_key: questionKey.key,
      });
      if (!isRequestCurrent(caseId, generation)) return;
      setConversation((previous) => {
        if (previous.caseId !== caseId) return previous;
        const submittedDraft = previous.draft.trim() === question;
        return {
          ...previous,
          turns: mergeTurns(previous.turns, [turn]),
          isSending: false,
          requestError: null,
          draft: submittedDraft ? "" : previous.draft,
          announcement: turn.status === "completed" ? "Answer received." : "Question submitted.",
        };
      });
      if (idempotencyRef.current?.caseId === caseId && idempotencyRef.current.key === questionKey.key) {
        idempotencyRef.current = null;
      }
    } catch (error) {
      if (!isRequestCurrent(caseId, generation)) return;
      setConversation((previous) => previous.caseId === caseId
        ? {
            ...previous,
            isSending: false,
            requestError: errorMessage(error, "Unable to send this question."),
            announcement: "The request did not return a result. You can retry this question.",
          }
        : previous);
      void refreshLatest(caseId, generation, false);
    }
  };

  const handleDraftChange = (value: string) => {
    if (idempotencyRef.current?.caseId === caseId && idempotencyRef.current.question !== value.trim()) {
      idempotencyRef.current = null;
    }
    setConversation((previous) => previous.caseId === caseId
      ? { ...previous, draft: value, requestError: null }
      : previous);
  };

  const visibleTurns = current.turns;

  const canSend = current.draft.trim().length > 0
    && current.draft.length <= MAX_QUESTION_LENGTH
    && !current.isLoading
    && !current.isSending;

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        openRef.current = nextOpen;
        onOpenChange(nextOpen);
      }}
    >
      <DialogContent
        ref={setPanelOrigin}
        showCloseButton={false}
        onOpenAutoFocus={(event) => { event.preventDefault(); textareaRef.current?.focus(); }}
        className="case-assistant-panel flex h-[min(680px,calc(100dvh-1rem))] w-[min(420px,calc(100vw-1rem))] max-w-none flex-col gap-0 overflow-hidden p-0 sm:h-[min(600px,calc(100dvh-5rem))]"
      >
        <DialogTitle className="sr-only">Case assistant for {caseName}</DialogTitle>
        <DialogDescription className="sr-only">Ask questions about this case and review cited answers.</DialogDescription>

        <div className="flex min-h-12 items-center justify-between gap-2 border-b border-line px-4 py-2">
          <span className="min-w-0 truncate rounded-chip bg-field px-2.5 py-1 text-[13px] font-medium text-ink">{caseName}</span>
          <div className="flex shrink-0 items-center gap-1">
            <Button type="button" variant="ghost" size="icon-xs" onClick={() => void refreshLatest(caseId, generationRef.current, true)} disabled={current.isLoading || current.isSending || current.isLoadingOlder} aria-label="Refresh conversation">
              <RotateCcw aria-hidden="true" />
            </Button>
            <DialogClose asChild>
              <Button type="button" variant="ghost" size="icon-xs" aria-label="Close assistant"><X aria-hidden="true" /></Button>
            </DialogClose>
          </div>
        </div>

        <MessageScrollerProvider autoScroll defaultScrollPosition="last-anchor">
          <MessageScroller className="min-h-0 flex-1">
            <MessageScrollerViewport aria-label={`Conversation about ${caseName}`} aria-busy={current.isLoading || current.isSending || current.isLoadingOlder} className="dashboard-scrollbar">
              <MessageScrollerContent className="gap-5 px-3 pt-3 pb-2">
                {current.nextBefore && (
                  <MessageScrollerItem messageId="older-questions" className="text-center">
                    <Button type="button" variant="ghost" size="sm" onClick={() => void loadOlder()} disabled={current.isLoadingOlder || current.isLoading}>
                      {current.isLoadingOlder ? "Loading Older Questions…" : "Load Older Questions"}
                    </Button>
                    {current.olderError && <p role="alert" className="mt-1 text-xs text-red">{current.olderError}</p>}
                  </MessageScrollerItem>
                )}

                {current.isLoading && visibleTurns.length === 0 && (
                  <MessageScrollerItem messageId="loading-conversation" className="py-8"><LoadingState label="Loading Conversation…" /></MessageScrollerItem>
                )}

                {current.loadError && (
                  <MessageScrollerItem messageId="load-error">
                    <Alert variant="destructive">
                      <MessageSquareText aria-hidden="true" />
                      <AlertTitle>Unable to Load the Conversation</AlertTitle>
                      <AlertDescription>
                        <p>{current.loadError}</p>
                        <Button type="button" variant="outline" size="sm" onClick={() => void refreshLatest(caseId, generationRef.current, true)}>Try Again</Button>
                      </AlertDescription>
                    </Alert>
                  </MessageScrollerItem>
                )}

                {!current.isLoading && !current.isSending && !current.loadError && visibleTurns.length === 0 && (
                  <MessageScrollerItem messageId="empty-conversation" className="py-10 text-center">
                    <p className="text-[13px] font-medium text-ink">Ask About This Case</p>
                    <p className="mt-1 text-[13px] leading-5 text-ink-3">Findings, evidence, and sources are all fair questions.</p>
                  </MessageScrollerItem>
                )}

                {visibleTurns.map((turn) => (
                  <MessageScrollerItem key={turn.id} messageId={turn.id} scrollAnchor>
                    <ConversationTurn turn={turn} />
                  </MessageScrollerItem>
                ))}

                {current.isSending && (
                  <MessageScrollerItem messageId="sending-question" scrollAnchor>
                    <QuestionBubble>{current.draft.trim()}</QuestionBubble>
                    <div className="mt-2.5"><LoadingState label="Thinking Through the Case…" /></div>
                  </MessageScrollerItem>
                )}

                {current.isLoading && visibleTurns.length > 0 && (
                  <MessageScrollerItem messageId="refreshing-conversation"><LoadingState label="Refreshing Conversation…" /></MessageScrollerItem>
                )}
              </MessageScrollerContent>
            </MessageScrollerViewport>
            <MessageScrollerButton />
          </MessageScroller>
        </MessageScrollerProvider>

        <div className="shrink-0 p-2">
          {current.requestError && (
            <Alert variant="destructive" className="mb-2">
              <Clock3 aria-hidden="true" />
              <AlertTitle>We Didn’t Receive a Result</AlertTitle>
              <AlertDescription id={requestErrorId}>
                <p>{current.requestError}</p>
                <p>Retry to continue this question. The same request key will be reused.</p>
              </AlertDescription>
            </Alert>
          )}
          <PromptBar
            inputRef={textareaRef}
            value={current.draft}
            onChange={handleDraftChange}
            onSubmit={() => void submitQuestion()}
            canSend={canSend}
            disabled={current.isSending}
            maxLength={MAX_QUESTION_LENGTH}
            placeholder="Ask about this case…"
            label="Ask a question about this case"
            describedBy={current.requestError ? requestErrorId : undefined}
            sendLabel="Send question"
          />
          <p role="status" aria-live="polite" className="sr-only">{current.announcement}</p>
        </div>
      </DialogContent>
    </Dialog>
  );
}
