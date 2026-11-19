// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ReactNode } from 'react';

import { AdminBreadcrumb } from './admin-breadcrumb';

/**
 * One column for every admin page: the breadcrumb back to the admin
 * home, then the page. Pages set only their own maximum width and
 * left-align inside this column, so a narrow form and a wide table
 * start at the same edge as the breadcrumb above them.
 */
export default function AdminLayout({ children }: { children: ReactNode }) {
  return (
    <div className="mx-auto w-full max-w-6xl px-6 pt-6">
      <AdminBreadcrumb />
      {children}
    </div>
  );
}
