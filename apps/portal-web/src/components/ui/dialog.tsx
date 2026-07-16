// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

/**
 * The shared modal primitive (#173). Every dialog in the portal
 * should compose these parts instead of hand-rolling a
 * fixed-inset-0 backdrop: Radix supplies focus trapping, escape
 * handling, scroll lock, aria-modal wiring, and portal rendering,
 * so those behaviors stop varying dialog to dialog.
 *
 * Usage shape (mirrors shadcn/ui so examples translate directly):
 *
 *   <Dialog open={open} onOpenChange={setOpen}>
 *     <DialogContent>
 *       <DialogHeader>
 *         <DialogTitle>Title</DialogTitle>
 *         <DialogDescription>Optional subtext</DialogDescription>
 *       </DialogHeader>
 *       ...body...
 *       <DialogFooter>
 *         <button>Cancel</button>
 *         <button>Save</button>
 *       </DialogFooter>
 *     </DialogContent>
 *   </Dialog>
 *
 * Accessibility note: Radix warns when a DialogContent has no
 * DialogTitle. Purely visual dialogs can pass a visually hidden
 * title via the `srTitle` prop instead.
 */
import {
  forwardRef,
  type ComponentPropsWithoutRef,
  type ElementRef,
  type ReactNode,
} from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { X } from 'lucide-react';

export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;
export const DialogPortal = DialogPrimitive.Portal;

export const DialogOverlay = forwardRef<
  ElementRef<typeof DialogPrimitive.Overlay>,
  ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(function DialogOverlay({ className = '', ...props }, ref) {
  return (
    <DialogPrimitive.Overlay
      ref={ref}
      className={`fixed inset-0 z-50 bg-black/40 backdrop-blur-sm animate-fade-in ${className}`}
      {...props}
    />
  );
});

interface DialogContentProps
  extends ComponentPropsWithoutRef<typeof DialogPrimitive.Content> {
  /** Width preset. `md` fits confirms and small forms; `lg` fits
   *  pickers and matrix-style dialogs; `xl` for near-full editors. */
  size?: 'sm' | 'md' | 'lg' | 'xl';
  /** Visually hidden title for dialogs whose visible chrome carries
   *  no heading; keeps Radix's accessibility contract satisfied. */
  srTitle?: string;
  /** Hide the top-right X close affordance (confirm dialogs render
   *  explicit Cancel buttons instead). */
  hideCloseButton?: boolean;
}

const SIZE_CLASS: Record<NonNullable<DialogContentProps['size']>, string> = {
  sm: 'max-w-sm',
  md: 'max-w-md',
  lg: 'max-w-2xl',
  xl: 'max-w-4xl',
};

export const DialogContent = forwardRef<
  ElementRef<typeof DialogPrimitive.Content>,
  DialogContentProps
>(function DialogContent(
  { className = '', size = 'md', srTitle, hideCloseButton, children, ...props },
  ref,
) {
  return (
    <DialogPortal>
      <DialogOverlay />
      <DialogPrimitive.Content
        ref={ref}
        className={`fixed left-1/2 top-1/2 z-50 w-[calc(100vw-2rem)] ${SIZE_CLASS[size]} -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border bg-surface-1 text-ink-1 shadow-overlay animate-slide-up focus:outline-none ${className}`}
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
            className="absolute right-3 top-3 inline-flex h-7 w-7 items-center justify-center rounded-md text-muted hover:bg-surface-2 hover:text-ink-1 focus:outline-none focus:ring-2 focus:ring-accent/30"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Content>
    </DialogPortal>
  );
});

export function DialogHeader({
  className = '',
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={`flex flex-col gap-1 border-b border-border px-5 py-4 ${className}`}>
      {children}
    </div>
  );
}

export const DialogTitle = forwardRef<
  ElementRef<typeof DialogPrimitive.Title>,
  ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(function DialogTitle({ className = '', ...props }, ref) {
  return (
    <DialogPrimitive.Title
      ref={ref}
      className={`text-base font-semibold tracking-tight text-ink-0 ${className}`}
      {...props}
    />
  );
});

export const DialogDescription = forwardRef<
  ElementRef<typeof DialogPrimitive.Description>,
  ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(function DialogDescription({ className = '', ...props }, ref) {
  return (
    <DialogPrimitive.Description
      ref={ref}
      className={`text-sm text-muted ${className}`}
      {...props}
    />
  );
});

export function DialogFooter({
  className = '',
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      className={`flex items-center justify-end gap-2 border-t border-border bg-surface-2/50 px-5 py-3 ${className}`}
    >
      {children}
    </div>
  );
}
