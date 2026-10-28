import { cn } from '@relay/ui';

/** Relay wordmark: a patch cord looping between two jacks. */
export function Logo({ className, withWord = true }: { className?: string; withWord?: boolean }) {
  return (
    <span className={cn('inline-flex items-center gap-2 font-semibold tracking-tight', className)}>
      <svg viewBox="0 0 32 32" className="size-7" aria-hidden>
        <circle cx="7" cy="23" r="4" className="fill-primary" />
        <circle cx="25" cy="9" r="4" className="fill-signal" />
        <path
          d="M7 23 C 7 8, 25 24, 25 9"
          fill="none"
          strokeWidth="2.5"
          strokeLinecap="round"
          className="stroke-foreground"
        />
      </svg>
      {withWord ? <span className="text-lg">Relay</span> : null}
    </span>
  );
}
