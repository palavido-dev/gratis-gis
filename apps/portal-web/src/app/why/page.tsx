// SPDX-License-Identifier: AGPL-3.0-or-later
import Link from 'next/link';
import type { Metadata } from 'next';
import { getServerSession } from 'next-auth';
import {
  ArrowLeft,
  Code2,
  Coffee,
  Compass,
  Github,
  Heart,
  LogIn,
  MessageSquarePlus,
} from 'lucide-react';
import { authOptions } from '@/lib/auth';

/**
 * /why - the project's "why it exists" page. This is the maintainer's
 * voice, deliberately first-person, not the org's marketing voice.
 * Linked from the public-landing footer.
 *
 * The page is content-only with no data fetching. The AppShell already
 * hides the global chrome for unauthenticated visitors, so this page
 * renders its own minimal TopBar in that case (matching public-landing's
 * pattern). For signed-in users the AppShell chrome is doing that job
 * already, so we suppress the public TopBar to avoid double headers.
 */
export const metadata: Metadata = {
  title: 'Why GratisGIS',
  description:
    'Why GratisGIS exists. A passion project from someone who has been doing GIS full time since the mid 1990s.',
};

export default async function WhyPage() {
  const session = await getServerSession(authOptions);
  const isAuthenticated = !!session;
  const repo =
    process.env.NEXT_PUBLIC_GITHUB_REPO ?? 'palavido-dev/gratis-gis';
  const repoUrl = `https://github.com/${repo}`;

  // Donation links. Both default to the canonical upstream
  // maintainer's handles (same convention as the repo URL above,
  // which defaults to palavido-dev/gratis-gis). Forks should
  // override via env so donations don't get misrouted to the
  // upstream maintainer. Set the env var to an empty string to
  // hide the button entirely.
  const sponsorsUrl =
    process.env.NEXT_PUBLIC_GITHUB_SPONSORS ??
    `https://github.com/sponsors/${repo.split('/')[0]}`;
  const paypalUrl =
    process.env.NEXT_PUBLIC_PAYPAL_DONATE ?? 'https://paypal.me/palavido';

  return (
    <div className="flex min-h-screen flex-col bg-surface-0">
      {!isAuthenticated ? <TopBar /> : null}

      <main className="mx-auto w-full max-w-3xl flex-1 px-6 py-12 sm:py-16">
        <Link
          href="/"
          className="inline-flex items-center gap-1.5 text-xs font-medium text-muted hover:text-ink-0"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Back to home
        </Link>

        <header className="mt-6">
          <p className="text-xs font-semibold uppercase tracking-wide text-accent">
            Why <span className="normal-case">GratisGIS</span>
          </p>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight text-ink-0 sm:text-4xl">
            A passion project, not a startup.
          </h1>
          <p className="mt-3 text-base text-muted">
            The shorter version: I built GratisGIS to give back some of
            what three decades of working in GIS has given me. It is free
            because that is the point.
          </p>
        </header>

        <section className="prose prose-invert mt-10 max-w-none space-y-6 text-base leading-relaxed text-ink-1">
          <h2 className="text-xl font-semibold tracking-tight text-ink-0">
            Three decades in
          </h2>
          <p>
            I have been doing GIS full time since the mid 1990s. Over
            those three decades I have been fortunate to work alongside
            people who share ideas freely, who are not driven by the sole
            goal of keeping knowledge to themselves so they stay
            &ldquo;valuable.&rdquo; That instinct, that a rising tide
            raises all ships, is the foundation of this project.
          </p>

          <h2 className="text-xl font-semibold tracking-tight text-ink-0">
            A culmination, not a product launch
          </h2>
          <p>
            GratisGIS is a culmination of all of that. The ideas, the
            challenges, the interactions with people, the things I have
            learned the hard way and the things I have watched commercial
            portals get wrong. This is my way to give some of that back
            so other people can use it, learn from it, or build on it.
          </p>
          <p>
            I understand the need to make a living. I have to swim in
            that pond too, and I am not hating on that. But money has
            never been my sole driver. Curiosity is. I want to keep
            learning, keep coming up with new ideas, keep sharing them.
          </p>

          <h2 className="text-xl font-semibold tracking-tight text-ink-0">
            Built on the side
          </h2>
          <p>
            This was built on weekends, nights, and lunch breaks. I am
            one person with kids, a full time job, and a life. So
            GratisGIS gets the time I can give it, on my own resources,
            and what you see here is the product of that time. If it
            works for you and you like the idea, great. If it does not,
            but you are still interested in where it is heading, I love
            constructive feedback.
          </p>

          <h2 className="text-xl font-semibold tracking-tight text-ink-0">
            How to participate
          </h2>
          <p>
            If you want to contribute financially, I appreciate that, but
            it is not necessary. If you want to share feedback or ideas,
            awesome, that is the kind of contribution I am most likely to
            act on. If you want to actually write code with me, let&rsquo;s
            talk.
          </p>
          <aside className="rounded-md border border-border bg-surface-1 p-4 text-sm text-ink-1">
            <p className="flex items-start gap-2">
              <Coffee className="mt-0.5 h-4 w-4 shrink-0 text-accent" />
              <span>
                Half joking, half not: if GratisGIS just saved your
                organization thousands of dollars you would have
                otherwise spent on a commercial GIS system, well, find
                it in your heart to show a little love. PayPal and
                GitHub Sponsors links are below. I am not above buying
                myself a coffee with it.
              </span>
            </p>
          </aside>
          <p className="text-ink-0">
            In the meantime, it is what the name implies: gratis. Free.
          </p>
        </section>

        <section className="mt-12 flex flex-wrap items-center gap-3">
          <a
            href={repoUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex h-10 items-center gap-2 rounded-md border border-border bg-surface-1 px-4 text-sm font-medium text-ink-1 hover:bg-surface-2"
          >
            <Github className="h-4 w-4" />
            View on GitHub
          </a>
          {/* #146: in-portal /feedback so testers without a GitHub
              account can leave a note. The page itself links out
              to GitHub Issues + Discussions for users who want
              the richer surface. */}
          <Link
            href="/feedback"
            className="inline-flex h-10 items-center gap-2 rounded-md bg-accent px-4 text-sm font-medium text-accent-foreground shadow-card hover:opacity-90"
          >
            <MessageSquarePlus className="h-4 w-4" />
            Send feedback
          </Link>
          <a
            href={`${repoUrl}/blob/main/CONTRIBUTING.md`}
            target="_blank"
            rel="noreferrer"
            className="inline-flex h-10 items-center gap-2 rounded-md border border-border bg-surface-1 px-4 text-sm font-medium text-ink-1 hover:bg-surface-2"
          >
            <Code2 className="h-4 w-4" />
            Contribute code
          </a>
          <a
            href={sponsorsUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex h-10 items-center gap-2 rounded-md border border-border bg-surface-1 px-4 text-sm font-medium text-ink-1 hover:bg-surface-2"
          >
            <Heart className="h-4 w-4 text-accent" />
            GitHub Sponsors
          </a>
          {paypalUrl ? (
            <a
              href={paypalUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex h-10 items-center gap-2 rounded-md border border-border bg-surface-1 px-4 text-sm font-medium text-ink-1 hover:bg-surface-2"
            >
              <Coffee className="h-4 w-4 text-accent" />
              PayPal
            </a>
          ) : null}
          <span className="inline-flex items-center gap-1.5 text-xs text-muted sm:ml-2">
            Built with care, on my own time.
          </span>
        </section>
      </main>

      <footer className="border-t border-border bg-surface-1 py-6 text-center text-xs text-muted">
        Powered by GratisGIS &middot;{' '}
        <Link href="/" className="underline hover:text-ink-0">
          Home
        </Link>{' '}
        &middot;{' '}
        <Link href="/credits" className="underline hover:text-ink-0">
          Built on
        </Link>
      </footer>
    </div>
  );
}

/**
 * Minimal public top bar for unauthenticated visitors. Mirrors
 * public-landing.tsx's TopBar so the chrome stays consistent across
 * the public surfaces (landing + this page).
 */
function TopBar() {
  return (
    <header className="flex items-center justify-between border-b border-border bg-surface-1 px-6 pt-[env(safe-area-inset-top)] [height:calc(3.5rem+env(safe-area-inset-top))]">
      <Link href="/" className="flex items-center gap-2">
        <Compass className="h-6 w-6 text-accent" />
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
