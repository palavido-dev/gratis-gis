// SPDX-License-Identifier: AGPL-3.0-or-later
import { TablePageSkeleton } from '@/components/skeleton';

/** Route-level skeleton while the admin AI settings fetch runs. */
export default function Loading() {
  return <TablePageSkeleton />;
}
