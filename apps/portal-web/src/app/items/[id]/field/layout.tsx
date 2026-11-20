// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ReactNode } from 'react';
import { FieldThemeScope } from '@/components/field-theme-scope';

/**
 * The per-deployment field runtime and its subroutes use the field
 * app theme, the same as the /field catalog (see FieldThemeScope).
 */
export default function FieldRuntimeLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <FieldThemeScope />
      {children}
    </>
  );
}
