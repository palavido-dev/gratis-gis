// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

/**
 * App-wide toast outlet (#173), mounted once inside the theme
 * provider. Import `toast` from '@/lib/toast' anywhere to fire
 * transient success / error / info notices.
 *
 * Toasts are for transient, non-blocking feedback (saved, moved,
 * failed to move). They are NOT for persistent error conditions
 * (keep those inline where the error lives) or decisions
 * (useConfirm / useAlert).
 */
import { useTheme } from 'next-themes';
import { Toaster } from 'sonner';

export function AppToaster() {
  const { resolvedTheme } = useTheme();
  return (
    <Toaster
      position="bottom-right"
      closeButton
      richColors
      theme={resolvedTheme === 'dark' ? 'dark' : 'light'}
      toastOptions={{
        classNames: {
          toast: 'rounded-lg border border-border shadow-raised',
        },
      }}
    />
  );
}
