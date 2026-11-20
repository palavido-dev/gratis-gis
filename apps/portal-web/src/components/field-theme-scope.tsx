// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

import { useEffect } from 'react';

/**
 * Puts the field app theme (see `.field-theme` in globals.css) on
 * <html> while a field route is mounted, and takes it off again when
 * the user leaves. On <html> rather than a wrapper div so sheets,
 * menus and dialogs that portal to <body> are themed too.
 */
export function FieldThemeScope() {
  useEffect(() => {
    const root = document.documentElement;
    root.classList.add('field-theme');
    return () => root.classList.remove('field-theme');
  }, []);
  return null;
}
