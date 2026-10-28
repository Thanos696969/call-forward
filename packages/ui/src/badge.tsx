import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from './cn';

export const badgeVariants = cva(
  'inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium',
  {
    variants: {
      tone: {
        green: 'bg-ok/15 text-ok',
        amber: 'bg-warn/15 text-warn',
        grey: 'bg-muted text-muted-foreground',
        red: 'bg-destructive/15 text-destructive',
        blue: 'bg-primary/12 text-primary',
      },
    },
    defaultVariants: { tone: 'grey' },
  },
);

export function Badge({
  className,
  tone,
  dot = true,
  children,
  ...props
}: React.HTMLAttributes<HTMLSpanElement> & VariantProps<typeof badgeVariants> & { dot?: boolean }) {
  return (
    <span className={cn(badgeVariants({ tone }), className)} {...props}>
      {dot ? <span aria-hidden className="size-1.5 rounded-full bg-current" /> : null}
      {children}
    </span>
  );
}
