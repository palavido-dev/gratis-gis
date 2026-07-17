// SPDX-License-Identifier: AGPL-3.0-or-later
import Link from 'next/link';
import type { Metadata } from 'next';
import { getServerSession } from 'next-auth';
import { ArrowLeft, LogIn } from 'lucide-react';
import { BrandMark } from '@/components/brand-mark';
import { authOptions } from '@/lib/auth';
import { FeedbackForm } from './feedback-form';

/**
 * /feedback - anonymous feedback page (#146). Lets a visitor leave a
 * comment without needing a GitHub account or a portal sign-in. POSTs
 * through the BFF to portal-api's @Public() /feedback endpoint, which
 * rate-limits per IP and emails the message to the maintainer via
 * the existing SMTP transport.
 *
 * Layout mirrors /why: a minimal TopBar when unauthenticated, the
 * AppShell chrome when signed in. Form lives in a client component
 * (feedback-form.tsx) because it's stateful + submits via fetch.
 */
export const metadata: Metadata = {
  title: 'Send feedback',
  description: 'Leave feedback on GratisGIS without needing a GitHub account.',
};

export default async function FeedbackPage() {
  const session = await getServerSession(authOptions);
  const isAuthenticated = !!session;
  const repo =
    process.env.NEXT_PUBLIC_GITHUB_REPO ?? 'palavido-dev/gratis-gis';
  const repoUrl = `https://github.com/${repo}`;

  return (
    <div className="flex min-h-screen flex-col bg-surface-0">
      {!isAuthenticated ? <TopBar /> : null}

      <main className="mx-auto w-full max-w-2xl flex-1 px-6 py-12 sm:py-16">
        <Link
          href="/"
          className="inline-flex items-center gap-1.5 text-xs font-medium text-muted hover:text-ink-0"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Back to home
        </Link>

        <header className="mt-6">
          <p className="text-xs font-semibold uppercase tracking-wide text-accent">
            Feedback
          </p>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight text-ink-0 sm:text-4xl">
            Tell us what worked, what didn&rsquo;t.
          </h1>
          <p className="mt-3 text-base text-muted">
            No account needed. Just leave a note and it goes to the
            maintainer&rsquo;s inbox. If you&rsquo;d like a reply,
            include your email. Everything else is optional.
          </p>
        </header>

        <FeedbackForm />

        <section className="mt-12 rounded-md border border-border bg-surface-1 p-4 text-sm leading-relaxed text-muted">
          <p className="font-medium text-ink-1">
            Prefer GitHub?
          </p>
          <p className="mt-1.5">
            If you have a reproducible bug and want to attach
            screenshots or paste logs, you can also{' '}
            <a
              href={`${repoUrl}/issues/new?labels=feedback%2Calpha&title=`}
              target="_blank"
              rel="noreferrer"
              className="underline hover:text-ink-0"
            >
              open an issue
            </a>{' '}
            or start a{' '}
            <a
              href={`${repoUrl}/discussions`}
              target="_blank"
              rel="noreferrer"
              className="underline hover:text-ink-0"
            >
              discussion
            </a>
            . Both require a GitHub account.
          </p>
        </section>
      </main>

      <footer className="border-t border-border bg-surface-1 py-6 text-center text-xs text-muted">
        Powered by GratisGIS &middot;{' '}
        <Link href="/why" className="underline hover:text-ink-0">
          Why GratisGIS
        </Link>
      </footer>
    </div>
  );
}

/**
 * Minimal public top bar mirroring /why's pattern so the chrome
 * stays consistent across the public surfaces.
 */
function TopBar() {
  return (
    <header className="flex items-center justify-between border-b border-border bg-surface-1 px-6 pt-[env(safe-area-inset-top)] [height:calc(3.5rem+env(safe-area-inset-top))]">
      <Link href="/" className="flex items-center gap-2">
        <BrandMark size={26} />
        <span className="text-base font-semibold tracking-tight">
          GratisGIS
        </span>
      </Link>
      <Link
        href="/signin"
        className="inline-flex h-9 items-center gap-1.5 rounded-md bg-accent px-3 text-sm font-medium text-accent-foreground hover:opacity-90"
      >
        <LogIn className="h-4 w-4" />
        Sign in
      </Link>
    </header>
  );
}

