// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

import { SessionProvider } from 'next-auth/react';
import { ThemeProvider } from 'next-themes';
import type { ReactNode } from 'react';

import { AppToaster } from '@/components/app-toaster';
import { DialogProvider } from '@/components/dialog-provider';
import { HelpDrawerProvider } from '@/components/help-drawer';
import { SessionExpiredNotice } from '@/components/session-expired-notice';
import { LocaleProvider } from '@/lib/i18n/locale-context';
import type { SupportedLocale } from '@/lib/i18n/locales';

export function Providers({
  children,
  locale,
  feedbackEnabled = false,
}: {
  children: ReactNode;
  /** #162 Phase 1.1 negotiated locale from the server. Plumbed
   *  in through the root layout so client components can read it
   *  via useLocale / useT. */
  locale: SupportedLocale;
  /** #146: portal-info features.feedback. The help drawer sits
   *  ABOVE the app shell in this tree, so it cannot read the flag
   *  from the shell and has to be handed it from the root layout. */
  feedbackEnabled?: boolean;
}) {
  return (
    <SessionProvider>
      {/* class strategy matches tailwind darkMode: 'class'; system
          default means anonymous visitors get their OS preference
          without ever touching the toggle. */}
      <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
        <LocaleProvider locale={locale}>
          <DialogProvider>
            <HelpDrawerProvider feedbackEnabled={feedbackEnabled}>
              {/* #195: must sit inside SessionProvider (reads
                  useSession) and LocaleProvider (reads useT); above
                  the app shell so the banner spans every page,
                  including full-viewport map editors. */}
              <SessionExpiredNotice />
              {children}
            </HelpDrawerProvider>
          </DialogProvider>
          <AppToaster />
        </LocaleProvider>
      </ThemeProvider>
    </SessionProvider>
  );
}
