// SPDX-License-Identifier: AGPL-3.0-or-later
import { TablePageSkeleton } from '@/components/skeleton';

/** Route-level skeleton (#173): layout-faithful placeholder while
 *  the server render's data fetches run. */
export default function Loading() {
  return <TablePageSkeleton />;
}
