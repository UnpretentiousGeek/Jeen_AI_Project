import { Markdown } from "@/components/ui/markdown"
import { cn } from "cn"
import { formatSourceExcerpt, sourceFacts } from "@/lib/source-excerpt"

// Stored document text keeps the ingestion's Markdown (tables as `| cell | cell |` rows), and a
// registry record is stored as labelled facts. Every place that shows source text goes through
// these two components so it never renders as raw table syntax or a JSON dump.

/** A full source passage: tables and lists render as they appeared in the document, and a registry record as its facts. */
function SourcePassage({ children, className }: { children: string; className?: string }) {
  const facts = sourceFacts(children)
  if (facts) {
    return (
      <dl className={cn("grid grid-cols-[minmax(0,auto)_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-sm leading-relaxed", className)}>
        {facts.map(([label, value], index) => (
          <div key={index} className="contents">
            <dt className="text-ink-3">{label}</dt>
            <dd className="break-words text-ink-2">{value}</dd>
          </div>
        ))}
      </dl>
    )
  }
  return <Markdown className={cn("text-sm leading-relaxed text-ink-2", className)}>{children}</Markdown>
}

/** A short quoted fragment, shown inline within surrounding text. */
function SourceExcerpt({ children, className }: { children: string; className?: string }) {
  return <span className={cn("whitespace-pre-line", className)}>{formatSourceExcerpt(children)}</span>
}

export { SourcePassage, SourceExcerpt }
