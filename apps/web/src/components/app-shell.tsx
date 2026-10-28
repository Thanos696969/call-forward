'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  Activity,
  LayoutDashboard,
  ListOrdered,
  LogOut,
  Menu,
  PhoneForwarded,
  Settings,
  Waypoints,
} from 'lucide-react';
import { Button, Dialog, DialogContent, DialogTitle, Skeleton, cn } from '@relay/ui';
import { api, ApiError } from '@/lib/api';
import { useMe } from '@/lib/queries';
import { Logo } from './logo';
import { ThemeToggle } from './theme-toggle';

const NAV = [
  { href: '/app', label: 'Dashboard', icon: LayoutDashboard, exact: true },
  { href: '/app/live', label: 'Live calls', icon: Activity, exact: false },
  { href: '/app/numbers', label: 'Numbers', icon: PhoneForwarded, exact: false },
  { href: '/app/campaigns', label: 'Campaigns', icon: Waypoints, exact: false },
  { href: '/app/calls', label: 'Call log', icon: ListOrdered, exact: false },
  { href: '/app/settings', label: 'Settings', icon: Settings, exact: false },
] as const;

function NavLinks({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();
  return (
    <nav aria-label="Main" className="grid gap-1">
      {NAV.map(({ href, label, icon: Icon, exact }) => {
        const active = exact ? pathname === href : pathname.startsWith(href);
        return (
          <Link
            key={href}
            href={href}
            onClick={onNavigate}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              active
                ? 'bg-primary text-primary-foreground'
                : 'text-muted-foreground hover:bg-muted hover:text-foreground',
            )}
          >
            <Icon className="size-4" aria-hidden />
            {label}
          </Link>
        );
      })}
    </nav>
  );
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const qc = useQueryClient();
  const me = useMe();
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    if (me.error instanceof ApiError && me.error.status === 401) {
      router.replace('/login');
    }
  }, [me.error, router]);

  async function logout() {
    try {
      await api('/auth/logout', { method: 'POST' });
    } finally {
      qc.clear();
      router.replace('/login');
    }
  }

  const account = (
    <div className="grid gap-2 border-t pt-4">
      {me.data ? (
        <div className="min-w-0 px-1">
          <p className="truncate text-sm font-medium">{me.data.org.name}</p>
          <p className="truncate text-xs text-muted-foreground">{me.data.user.email}</p>
        </div>
      ) : (
        <Skeleton className="h-9" />
      )}
      <Button variant="ghost" className="justify-start px-3" onClick={logout}>
        <LogOut aria-hidden /> Sign out
      </Button>
    </div>
  );

  return (
    <div className="min-h-dvh md:grid md:grid-cols-[15rem_1fr]">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:left-2 focus:top-2 focus:z-50 focus:rounded focus:bg-surface focus:px-3 focus:py-2"
      >
        Skip to content
      </a>
      <aside className="sticky top-0 hidden h-dvh flex-col gap-6 border-r bg-surface p-4 md:flex">
        <Link
          href="/app"
          className="rounded px-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Logo />
        </Link>
        <div className="flex-1">
          <NavLinks />
        </div>
        {account}
      </aside>

      <div className="flex min-w-0 flex-col">
        <header className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b bg-background/90 px-4 backdrop-blur md:px-8">
          <Button
            variant="ghost"
            size="icon"
            className="md:hidden"
            aria-label="Open menu"
            onClick={() => setMenuOpen(true)}
          >
            <Menu />
          </Button>
          <Link href="/app" className="md:hidden">
            <Logo withWord={false} />
          </Link>
          {me.data ? (
            <p className="hidden min-w-0 items-baseline gap-3 truncate text-sm md:flex">
              <span className="font-medium">{me.data.org.name}</span>
              <span className="text-muted-foreground">
                Times in {me.data.org.timezone.replace(/_/g, ' ')}
              </span>
            </p>
          ) : null}
          <div className="ml-auto">
            <ThemeToggle />
          </div>
        </header>
        <main id="main" className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 md:px-8 md:py-8">
          {children}
        </main>
      </div>

      <Dialog open={menuOpen} onOpenChange={setMenuOpen}>
        <DialogContent className="left-0 top-0 flex h-dvh max-h-none w-72 max-w-[85vw] translate-x-0 translate-y-0 flex-col rounded-none">
          <DialogTitle className="sr-only">Menu</DialogTitle>
          <Logo />
          <div className="flex-1">
            <NavLinks onNavigate={() => setMenuOpen(false)} />
          </div>
          {account}
        </DialogContent>
      </Dialog>
    </div>
  );
}

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0">
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {description ? <p className="mt-1 text-sm text-muted-foreground">{description}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 gap-2">{actions}</div> : null}
    </div>
  );
}

export function EmptyState({
  title,
  body,
  action,
}: {
  title: string;
  body: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-start gap-3 rounded-lg border border-dashed p-8">
      <h2 className="text-base font-semibold">{title}</h2>
      <p className="max-w-prose text-sm text-muted-foreground">{body}</p>
      {action}
    </div>
  );
}
