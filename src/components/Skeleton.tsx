export function Skeleton({
  className = "",
}: {
  className?: string;
}) {
  return <div className={`skeleton ${className}`} />;
}

export function SkeletonTable({ rows = 6, cols = 5 }: { rows?: number; cols?: number }) {
  return (
    <div className="flex-1 overflow-hidden">
      <div className="px-3 py-2 space-y-0">
        {Array.from({ length: rows }).map((_, i) => (
          <div
            key={i}
            className="flex gap-3 border-b border-(--color-border)/50 py-2 items-center"
            style={{ animationDelay: `${i * 40}ms` }}
          >
            {Array.from({ length: cols }).map((_, j) => (
              <Skeleton
                key={j}
                className={`h-3 rounded ${j === cols - 1 ? "w-12" : j === 0 ? "w-10" : "flex-1"}`}
              />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

export function SkeletonCard() {
  return (
    <div className="rounded border border-(--color-border) bg-(--color-surface) p-4 space-y-3">
      <Skeleton className="h-3 w-16" />
      <Skeleton className="h-7 w-24" />
      <Skeleton className="h-10 w-full" />
    </div>
  );
}
