import type { Config } from 'tailwindcss';
import animate from 'tailwindcss-animate';

const token = (name: string) => `hsl(var(--${name}) / <alpha-value>)`;

export default {
  darkMode: ['class'],
  content: ['./src/**/*.{ts,tsx}', '../../packages/ui/src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['"Archivo Variable"', 'ui-sans-serif', 'system-ui', 'sans-serif'],
      },
      colors: {
        background: token('background'),
        surface: token('surface'),
        foreground: token('foreground'),
        muted: { DEFAULT: token('muted'), foreground: token('muted-foreground') },
        border: token('border'),
        input: token('input'),
        ring: token('ring'),
        primary: { DEFAULT: token('primary'), foreground: token('primary-foreground') },
        signal: { DEFAULT: token('signal'), foreground: token('signal-foreground') },
        ok: token('ok'),
        warn: token('warn'),
        destructive: { DEFAULT: token('destructive'), foreground: token('destructive-foreground') },
      },
      borderColor: { DEFAULT: token('border') },
    },
  },
  plugins: [animate],
} satisfies Config;
