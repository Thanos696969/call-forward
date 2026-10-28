'use client';

import { Moon, Sun } from 'lucide-react';
import { useTheme } from 'next-themes';
import { Button } from '@relay/ui';

/** Icon swap is CSS-driven (dark: variant), so server and client markup always match. */
export function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme();
  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={() => setTheme(resolvedTheme === 'dark' ? 'light' : 'dark')}
      aria-label="Toggle light or dark theme"
    >
      <Sun className="hidden dark:block" aria-hidden />
      <Moon className="dark:hidden" aria-hidden />
    </Button>
  );
}
