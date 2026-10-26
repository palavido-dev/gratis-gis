// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Stable import path for the toast API (#173). Components import
 * from here rather than from sonner directly so the underlying
 * library can be swapped without touching call sites.
 *
 *   import { toast } from '@/lib/toast';
 *   toast.success(t('items.moved'));
 *   toast.error(title, { description });
 *
 *   // Hook form (same API; preferred when a component wants a
 *   // toast object rather than a module import):
 *   const { toast } = useToast();
 */
import { toast } from 'sonner';

export { toast };

export function useToast(): { toast: typeof toast } {
  return { toast };
}
