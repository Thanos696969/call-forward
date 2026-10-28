import { cn } from '@relay/ui';
import { formatPhone } from '@/lib/format';

interface Jack {
  caption: string;
  value: string | null;
  tone: 'muted' | 'primary' | 'signal';
}

/**
 * Caller → your Relay number → destination, drawn as jacks joined by a patch cord.
 * `live` animates the cord; `broken` dashes it to show forwarding is off.
 */
export function RouteDiagram({
  from = 'Any caller',
  number,
  destination,
  live = false,
  broken = false,
  className,
}: {
  from?: string;
  number: string;
  destination: string | null;
  live?: boolean;
  broken?: boolean;
  className?: string;
}) {
  const jacks: Jack[] = [
    { caption: 'Caller dials', value: from, tone: 'muted' },
    { caption: 'Your Relay number', value: number, tone: 'primary' },
    { caption: broken ? 'Forwarding off' : 'Rings', value: destination, tone: 'signal' },
  ];
  return (
    <figure
      className={cn('flex flex-col items-stretch gap-0 md:flex-row md:items-center', className)}
      aria-label={`Calls to ${formatPhone(number)} ${broken || !destination ? 'are not forwarded' : `forward to ${formatPhone(destination)}`}`}
    >
      {jacks.map((jack, i) => (
        <div key={jack.caption} className="flex flex-col md:flex-1 md:flex-row md:items-center">
          <JackNode jack={jack} />
          {i < jacks.length - 1 ? <Cord live={live && !broken} broken={broken && i === 1} /> : null}
        </div>
      ))}
    </figure>
  );
}

function JackNode({ jack }: { jack: Jack }) {
  return (
    <div className="flex min-w-0 items-center gap-3 md:flex-col md:items-start md:gap-2">
      <span
        aria-hidden
        className={cn(
          'grid size-9 shrink-0 place-items-center rounded-full ring-4',
          jack.tone === 'primary' && 'bg-primary ring-primary/20',
          jack.tone === 'signal' && 'bg-signal ring-signal/25',
          jack.tone === 'muted' && 'bg-muted-foreground/60 ring-muted',
        )}
      >
        <span className="size-3 rounded-full bg-background" />
      </span>
      <span className="min-w-0">
        <span className="block text-xs text-muted-foreground">{jack.caption}</span>
        <span className="tnum block truncate text-base font-semibold md:text-lg">
          {jack.value
            ? jack.value.startsWith('+')
              ? formatPhone(jack.value)
              : jack.value
            : 'Not set'}
        </span>
      </span>
    </div>
  );
}

function Cord({ live, broken }: { live: boolean; broken: boolean }) {
  const tone = broken ? 'muted' : live ? 'live' : 'idle';
  return (
    <>
      <span
        aria-hidden
        className={cn(
          'my-1 ml-[16px] block h-7 w-[3px] rounded-full md:hidden',
          tone === 'muted' && 'bg-muted-foreground/30',
          tone === 'idle' && 'bg-foreground/60',
          tone === 'live' && 'animate-pulse bg-signal',
        )}
      />
      <svg
        aria-hidden
        className="mx-3 hidden h-8 min-w-12 flex-1 md:block"
        viewBox="0 0 100 32"
        preserveAspectRatio="none"
      >
        <path
          d="M0 16 C 30 0, 70 32, 100 16"
          fill="none"
          vectorEffect="non-scaling-stroke"
          strokeWidth="3"
          strokeLinecap="round"
          className={cn(
            tone === 'muted' && 'stroke-muted-foreground/40 [stroke-dasharray:4_6]',
            tone === 'idle' && 'stroke-foreground/60',
            tone === 'live' && 'cord-live stroke-signal',
          )}
        />
      </svg>
    </>
  );
}
