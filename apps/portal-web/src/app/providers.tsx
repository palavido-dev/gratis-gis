'use client';

import { SessionProvider } from 'next-auth/react';
import type { ReactNode } from 'react';

import { DialogProvider } from '@/components/dialog-provider';

export function Providers({ children }: { children: ReactNode }) {
  return (
    <SessionProvider>
      <DialogProvider>{children}</DialogProvider>
    </SessionProvider>
  );
}
