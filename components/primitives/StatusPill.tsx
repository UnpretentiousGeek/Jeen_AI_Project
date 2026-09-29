import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/* Status pill colours come from the beautifului foundation (.filter-status-*). */
export type StatusTone = "todo" | "progress" | "done" | "danger" | "neutral";

/** Tinted status pill shared by tables and headers. */
export function StatusPill({ tone, children, className }: { tone: StatusTone; children: ReactNode; className?: string }) {
  return (
    <span className={cn(
      "inline-flex h-[23px] shrink-0 items-center gap-1.5 whitespace-nowrap rounded-[8px] border px-[7px] text-[12.5px] font-medium",
      `filter-status-${tone}`,
      className,
    )}>
      {children}
    </span>
  );
}
