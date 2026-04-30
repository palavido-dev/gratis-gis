import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { Inter } from 'next/font/google';
import { AppShell } from '@/components/app-shell';
import { SwRegistrar } from '@/components/sw-registrar';
import { Providers } from './providers';
import './globals.css';

const inter = Inter({ subsets: ['latin'], variable: '--font-sans' });

export const metadata: Metadata = {
  title: { default: 'GratisGIS', template: '%s · GratisGIS' },
  description:
    'Open-source geospatial portal, maps, app builder, field data collection, and reporting.',
  manifest: '/manifest.json',
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
  // Theme color appears in both the OS status bar (Android Chrome
  // standalone) and the iOS splash screen. Matches manifest.json
  // for consistency.
  themeColor: '#0f0f10',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={inter.variable}>
      <body className="font-sans antialiased">
        <Providers>
          <AppShell>{children}</AppShell>
        </Providers>
        <SwRegistrar />
      </body>
    </html>
  );
}
