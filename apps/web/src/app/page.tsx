import Link from 'next/link';
import { Button } from '@relay/ui';
import { Logo } from '@/components/logo';
import { RouteDiagram } from '@/components/route-diagram';
import { ThemeToggle } from '@/components/theme-toggle';

const SAMPLE_CALLS = [
  { from: '+1 (312) 555-0187', result: 'Answered', length: '4m 12s', tone: 'text-ok' },
  { from: '+1 (646) 555-0144', result: 'Answered', length: '1m 03s', tone: 'text-ok' },
  { from: '+1 (213) 555-0199', result: 'No answer', length: '25s ring', tone: 'text-warn' },
];

const FEATURES = [
  {
    title: 'A toll-free number in seconds',
    body: 'Search 800, 833, 844, 855, 866, 877 and 888 numbers by the digits you want. It works the moment you buy it.',
  },
  {
    title: 'Rings the phone you choose',
    body: 'Point the number at a mobile, office line or call centre. Callers see a normal ring until someone picks up.',
  },
  {
    title: 'Every call on the record',
    body: 'Who called, which number they dialled, how long you talked and whether anyone answered, within seconds of hanging up.',
  },
];

export default function LandingPage() {
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="mx-auto flex w-full max-w-6xl items-center justify-between px-4 py-5 sm:px-8">
        <Logo />
        <nav aria-label="Account" className="flex items-center gap-1 sm:gap-2">
          <ThemeToggle />
          <Button asChild variant="ghost">
            <Link href="/login">Sign in</Link>
          </Button>
          <Button asChild className="hidden sm:inline-flex">
            <Link href="/register">Create account</Link>
          </Button>
        </nav>
      </header>

      <main className="flex-1">
        <section className="mx-auto grid max-w-6xl gap-12 px-4 pb-20 pt-10 sm:px-8 lg:grid-cols-[1.05fr_1fr] lg:items-center lg:pt-20">
          <div className="max-w-xl">
            <h1 className="text-4xl font-semibold leading-[1.05] tracking-tight sm:text-5xl lg:text-[3.5rem]">
              Get a toll-free number. Ring any phone.
            </h1>
            <p className="mt-5 max-w-[34rem] text-lg leading-relaxed text-muted-foreground">
              Relay forwards every call to the line that should answer it and keeps a log of each
              one, so you always know who called and what happened.
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <Button asChild size="lg">
                <Link href="/register">Create account</Link>
              </Button>
              <Button asChild size="lg" variant="outline">
                <Link href="/login">Sign in</Link>
              </Button>
            </div>
          </div>

          <div className="rounded-xl border bg-surface p-5 sm:p-7">
            <RouteDiagram
              from="+1 (312) 555-0187"
              number="+18335550142"
              destination="+14155550123"
              live
            />
            <div className="mt-7 border-t pt-4">
              <p className="mb-2 text-sm font-medium">Today</p>
              <ul className="grid gap-2 text-sm">
                {SAMPLE_CALLS.map((c) => (
                  <li key={c.from} className="tnum flex items-baseline justify-between gap-4">
                    <span className="truncate">{c.from}</span>
                    <span className="flex shrink-0 gap-4">
                      <span className={c.tone}>{c.result}</span>
                      <span className="w-16 text-right text-muted-foreground">{c.length}</span>
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </section>

        <section aria-labelledby="features" className="border-y bg-surface">
          <h2 id="features" className="sr-only">
            What Relay does
          </h2>
          <div className="mx-auto grid max-w-6xl divide-y px-4 sm:px-8 md:grid-cols-3 md:divide-x md:divide-y-0">
            {FEATURES.map((f) => (
              <div key={f.title} className="py-8 md:px-8 md:first:pl-0 md:last:pr-0">
                <h3 className="text-lg font-semibold">{f.title}</h3>
                <p className="mt-2 leading-relaxed text-muted-foreground">{f.body}</p>
              </div>
            ))}
          </div>
        </section>

        <section className="mx-auto flex max-w-6xl flex-col items-start gap-5 px-4 py-20 sm:px-8 md:flex-row md:items-center md:justify-between">
          <p className="max-w-xl text-2xl font-semibold tracking-tight">
            Set up your first number in about two minutes.
          </p>
          <Button asChild size="lg" variant="signal">
            <Link href="/register">Create account</Link>
          </Button>
        </section>

        <section aria-labelledby="terms" className="border-t">
          <div className="mx-auto grid max-w-6xl gap-10 px-4 py-14 text-sm leading-relaxed text-muted-foreground sm:px-8 md:grid-cols-2">
            <div id="terms-and-conditions">
              <h2 id="terms" className="mb-3 text-base font-semibold text-foreground">
                Terms and Conditions
              </h2>
              <p>
                By creating an account you agree to use Relay numbers lawfully. You may not use
                Relay for illegal robocalls, harassment, fraud or calls that break telemarketing
                rules such as the TCPA. Relay numbers are not for emergency calls and do not connect
                to 911.
              </p>
              <p className="mt-3">
                You are responsible for the destinations you forward calls to and for any consent
                your callers need. We may suspend numbers that are used to cause harm. Service is
                provided as is during the beta, and these terms may change with notice in the app.
              </p>
            </div>
            <div id="privacy-policy">
              <h2 className="mb-3 text-base font-semibold text-foreground">Privacy Policy</h2>
              <p>
                We store what we need to run the service: your account details, the numbers you own,
                your forwarding settings and a record of each call (caller number, dialled number,
                destination, times and outcome). We do not record call audio.
              </p>
              <p className="mt-3">
                Your data is used only to route and report on your calls. We share it only with the
                phone carrier that connects them and never sell it. You can ask support to delete
                your account and its call history at any time.
              </p>
            </div>
          </div>
        </section>
      </main>

      <footer className="border-t">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-6 text-sm text-muted-foreground sm:px-8">
          <span>© {new Date().getFullYear()} Relay</span>
          <span className="flex gap-4">
            <a href="#terms-and-conditions" className="hover:text-foreground">
              Terms and Conditions
            </a>
            <a href="#privacy-policy" className="hover:text-foreground">
              Privacy Policy
            </a>
          </span>
        </div>
      </footer>
    </div>
  );
}
