// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

/**
 * Shared side-panel primitive (#173). Sheets are modal drawers —
 * same Radix Dialog focus trap / escape / scroll-lock contract as
 * `ui/dialog`, but anchored to an edge instead of centered.
 *
 *   <Sheet open={open} onOpenChange={setOpen}>
 *     <SheetContent side="right" size="lg">
 *       <SheetHeader>
 *         <SheetTitle>Title</SheetTitle>
 *         <SheetDescription>Optional subtext</SheetDescription>
 *       </SheetHeader>
 *       ...body...
 *     </SheetContent>
 *   </Sheet>
 */
import {
  forwardRef,
  type ComponentPropsWithoutRef,
  type ElementRef,
  type ReactNode,
} from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { X } from 'lucide-react';

export const Sheet = DialogPrimitive.Root;
export const SheetTrigger = DialogPrimitive.Trigger;
export const SheetClose = DialogPrimitive.Close;
export const SheetPortal = DialogPrimitive.Portal;

export const SheetOverlay = forwardRef<
  ElementRef<typeof DialogPrimitive.Overlay>,
  ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(function SheetOverlay({ className = '', ...props }, ref) {
  return (
    <DialogPrimitive.Overlay
      ref={ref}
      className={`fixed inset-0 z-40 bg-black/30 animate-fade-in ${className}`}
      {...props}
    />
  );
});

interface SheetContentProps
  extends ComponentPropsWithoutRef<typeof DialogPrimitive.Content> {
  side?: 'right' | 'left';
  /** Width preset for horizontal sheets. */
  size?: 'md' | 'lg' | 'xl';
  srTitle?: string;
  hideCloseButton?: boolean;
}

const SIDE_CLASS: Record<NonNullable<SheetContentProps['side']>, string> = {
  right: 'inset-y-0 right-0 h-full border-l animate-sheet-in-right',
  left: 'inset-y-0 left-0 h-full border-r animate-sheet-in-left',
};

const SIZE_CLASS: Record<NonNullable<SheetContentProps['size']>, string> = {
  md: 'max-w-md',
  lg: 'max-w-3xl',
  xl: 'max-w-5xl',
};

export const SheetContent = forwardRef<
  ElementRef<typeof DialogPrimitive.Content>,
  SheetContentProps
>(function SheetContent(
  {
    className = '',
    side = 'right',
    size = 'lg',
    srTitle,
    hideCloseButton,
    children,
    ...props
  },
  ref,
) {
  return (
    <SheetPortal>
      <SheetOverlay />
      <DialogPrimitive.Content
        ref={ref}
        className={`fixed z-40 flex w-full ${SIZE_CLASS[size]} ${SIDE_CLASS[side]} flex-col border-border bg-surface-1 text-ink-1 shadow-overlay focus:outline-hidden ${className}`}
        {...props}
      >
        {srTitle ? (
          <DialogPrimitive.Title className="sr-only">
            {srTitle}
          </DialogPrimitive.Title>
        ) : null}
        {children}
        {hideCloseButton ? null : (
          <DialogPrimitive.Close
            className="absolute right-3 top-3 inline-flex h-8 w-8 items-center justify-center rounded text-muted hover:bg-surface-2 hover:text-ink-1 focus:outline-hidden focus:ring-2 focus:ring-accent/30"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Content>
    </SheetPortal>
  );
});

export function SheetHeader({
  className = '',
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      className={`flex items-start justify-between gap-3 border-b border-border px-4 py-3 ${className}`}
    >
      {children}
    </div>
  );
}

export const SheetTitle = forwardRef<
  ElementRef<typeof DialogPrimitive.Title>,
  ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(function SheetTitle({ className = '', ...props }, ref) {
  return (
    <DialogPrimitive.Title
      ref={ref}
      className={`truncate text-base font-semibold text-ink-0 ${className}`}
      {...props}
    />
  );
});

export const SheetDescription = forwardRef<
  ElementRef<typeof DialogPrimitive.Description>,
  ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(function SheetDescription({ className = '', ...props }, ref) {
  return (
    <DialogPrimitive.Description
      ref={ref}
      className={`text-2xs font-medium uppercase tracking-wide text-muted ${className}`}
      {...props}
    />
  );
});
