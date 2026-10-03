// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ReactNode } from 'react';
import { Sparkles } from 'lucide-react';

/**
 * Empty states follow a strict pattern: small icon, two lines of copy
 * (what and why), and a single clear action. No walls of text.
 */
export function EmptyState({
  title,
  description,
  action,
  icon,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
  icon?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-border bg-surface-1 px-6 py-16 text-center">
      <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-surface-2 text-muted">
        {icon ?? <Sparkles className="h-5 w-5" />}
      </div>
      <h3 className="text-base font-semibold">{title}</h3>
      {description ? (
        <p className="mt-1 max-w-sm text-sm leading-relaxed text-muted">
          {description}
        </p>
      ) : null}
      {action ? <div className="mt-5">{action}</div> : null}
    </div>
  );
}
