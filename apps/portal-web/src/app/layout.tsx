// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { Inter } from 'next/font/google';
import { AppShell } from '@/components/app-shell';
import { SwRegistrar } from '@/components/sw-registrar';
import { getPortalUrl } from '@/lib/portal-url';
import { getServerLocale } from '@/lib/i18n/server';
import { Providers } from './providers';
import './globals.css';

const inter = Inter({ subsets: ['latin'], variable: '--font-sans' });

const PORTAL_URL = getPortalUrl();
const SITE_DESCRIPTION =
  'Open-source, self-hosted geospatial portal. Web maps, app builder, offline field collection, visual tool builder. Built on PostGIS, MapLibre, and Next.js. AGPL-3.0.';

export const metadata: Metadata = {
  metadataBase: new URL(PORTAL_URL),
  title: { default: 'GratisGIS', template: '%s · GratisGIS' },
  description: SITE_DESCRIPTION,
  applicationName: 'GratisGIS',
  manifest: '/manifest.json',
  // Canonical link tag.  Self-host deployments that set
  // NEXT_PUBLIC_PORTAL_URL produce a correct canonical for their
  // own origin; the gratisgis.org default keeps the public preview
  // canonical.
  alternates: {
    canonical: '/',
  },
  // Open Graph card.  /opengraph-image is auto-generated at the
  // app/opengraph-image.tsx route; Next.js injects it as the
  // og:image URL.  Twitter card piggybacks on the same image.
  openGraph: {
    type: 'website',
    siteName: 'GratisGIS',
    title: 'GratisGIS — open-source self-hosted geospatial portal',
    description: SITE_DESCRIPTION,
    url: PORTAL_URL,
    locale: 'en_US',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'GratisGIS — open-source self-hosted geospatial portal',
    description: SITE_DESCRIPTION,
  },
  // Help robots understand we want every public page indexed.
  // Page-level overrides (e.g. signin) can set noindex inline.
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      'max-image-preview': 'large',
      'max-snippet': -1,
      'max-video-preview': -1,
    },
  },
  // PWA install hints for iOS Safari. iOS doesn't auto-prompt; users
  // tap Share -> Add to Home Screen. These tags tell iOS to render
  // the installed instance in standalone mode (no browser chrome)
  // and pick a sensible status-bar color so the field runtime fills
  // the screen edge-to-edge. Android Chrome reads these from
  // manifest.json instead, so this is purely the iOS path.
  appleWebApp: {
    capable: true,
    title: 'GratisGIS',
    statusBarStyle: 'black-translucent',
  },
};

export const viewport: Viewport = {
  // viewportFit: 'cover' is what makes env(safe-area-inset-*) return
  // real pixel values on iPhones with rounded corners / notches.
  // Without it the insets are zero and bottom-anchored UI
  // (add-feature sheet, attribute table) clips behind the home
  // indicator.
  viewportFit: 'cover',
  // Theme color appears in both the OS status bar (Android Chrome
  // standalone) and the iOS splash screen. Paired per color-scheme
  // so the status bar matches whichever mode the user runs; the
  // values are surface-0 in each theme.
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#ffffff' },
    { media: '(prefers-color-scheme: dark)', color: '#080d16' },
  ],
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  // #162 Phase 1.1: read the negotiated locale (cookie -> Accept-
  // Language -> default) and plumb it through to the client tree.
  // <html lang> also picks up the locale so screen readers and
  // browser auto-translation respect the user's choice.
  const locale = await getServerLocale();
  return (
    // suppressHydrationWarning: next-themes mutates <html> class/style
    // before hydration to avoid a light-flash; React would otherwise
    // warn about the server/client attribute mismatch.
    <html lang={locale} className={inter.variable} suppressHydrationWarning>
      <body className="font-sans antialiased">
        <Providers locale={locale}>
          <AppShell>{children}</AppShell>
        </Providers>
        <SwRegistrar />
      </body>
    </html>
  );
}
