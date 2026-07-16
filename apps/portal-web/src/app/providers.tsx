// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

import { SessionProvider } from 'next-auth/react';
import { ThemeProvider } from 'next-themes';
import type { ReactNode } from 'react';

import { AppToaster } from '@/components/app-toaster';
import { DialogProvider } from '@/components/dialog-provider';
import { HelpDrawerProvider } from '@/components/help-drawer';
import { LocaleProvider } from '@/lib/i18n/locale-context';
import type { SupportedLocale } from '@/lib/i18n/locales';

export function Providers({
  children,
  locale,
}: {
  children: ReactNode;
  /** #162 Phase 1.1 negotiated locale from the server. Plumbed
   *  in through the root layout so client components can read it
   *  via useLocale / useT. */
  locale: SupportedLocale;
}) {
  return (
    <SessionProvider>
      {/* class strategy matches tailwind darkMode: 'class'; system
          default means anonymous visitors get their OS preference
          without ever touching the toggle. */}
      <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
        <LocaleProvider locale={locale}>
          <DialogProvider>
            <HelpDrawerProvider>{children}</HelpDrawerProvider>
          </DialogProvider>
          <AppToaster />
        </LocaleProvider>
      </ThemeProvider>
    </SessionProvider>
  );
}
