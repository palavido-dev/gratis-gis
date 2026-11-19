// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ReactNode } from 'react';

import { AdminBreadcrumb } from './admin-breadcrumb';

/** Every admin page gets a way back to the admin home. */
export default function AdminLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <AdminBreadcrumb />
      {children}
    </>
  );
}
