const CHEVRON_DELAYS = Array.from({ length: 9 }, (_, index) => {
  const row = Math.floor(index / 3);
  const column = index % 3;
  return (column + Math.abs(row - 1)) * 90;
});

export default function LoadingState({
  label = "Starting case analysis",
  compact = false,
}: {
  label?: string;
  compact?: boolean;
}) {
  return (
    <div role="status" aria-label={label} className="flex w-fit items-center gap-2.5">
      <span aria-hidden="true" className="grid shrink-0 grid-cols-[repeat(3,4px)] gap-[1.5px]">
        {CHEVRON_DELAYS.map((delay, index) => (
          <span
            key={index}
            className="size-[4px] rounded-[1px] bg-ink"
            style={{ opacity: 0.15, animation: `pixel-on 650ms ease-in-out ${delay}ms infinite` }}
          />
        ))}
      </span>
      <span
        aria-hidden={compact}
        className={compact ? "sr-only" : "bg-clip-text text-[13px] font-medium text-transparent"}
        style={{
          backgroundImage: "linear-gradient(90deg, var(--ink-3) 35%, var(--ink) 50%, var(--ink-3) 65%)",
          backgroundSize: "200% 100%",
          animation: "shimmer-text 1.4s linear infinite",
        }}
      >
        {label}
      </span>
    </div>
  );
}
