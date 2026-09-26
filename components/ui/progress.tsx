import { cn } from "@/lib/utils";

export function Progress({ value, className, indeterminate }: { value: number; className?: string; indeterminate?: boolean }) {
  return (
    <div className={cn("relative h-2 w-full overflow-hidden rounded-full bg-muted", className)}>
      {indeterminate ? (
        <div className="absolute inset-y-0 w-1/3 animate-[slide_1.2s_ease-in-out_infinite] rounded-full bg-primary/70" />
      ) : (
        <div className="h-full rounded-full bg-primary transition-[width] duration-500" style={{ width: `${Math.round(Math.max(0, Math.min(1, value)) * 100)}%` }} />
      )}
      <style>{`@keyframes slide{0%{left:-33%}100%{left:100%}}`}</style>
    </div>
  );
}
