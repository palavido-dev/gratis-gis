// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { cn } from './cn';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  children: ReactNode;
}

const variantClasses: Record<Variant, string> = {
  // ink/surface tokens invert with the theme, so "primary" stays a
  // strong-contrast neutral button in both light and dark mode.
  primary: 'bg-ink-1 text-surface-0 hover:opacity-90',
  secondary: 'bg-surface-2 text-ink-1 hover:bg-muted/20',
  ghost: 'bg-transparent text-ink-1 hover:bg-surface-2',
  danger: 'bg-danger text-white hover:bg-danger/90',
};

export function Button({
  variant = 'primary',
  className,
  children,
  ...rest
}: ButtonProps) {
  return (
    <button
      className={cn(
        'inline-flex items-center justify-center rounded-md px-4 py-2 text-sm font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-slate-400 disabled:cursor-not-allowed disabled:opacity-50',
        variantClasses[variant],
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
}
