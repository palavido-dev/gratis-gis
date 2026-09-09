// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

/**
 * Keeps the offline store's idea of "whose device is this" in step
 * with the signed-in session. Renders nothing until it has something
 * to ask.
 *
 * The write queue and the pending files survive sign-out on purpose:
 * destroying unsynced field work to tidy a cache is the worse
 * outcome. Until ownership existed that meant whoever signed in next
 * replayed them under THEIR session, and the server stamped
 * `submitted_by` from the caller. Rows now record who captured them
 * and both drains send only the current account's, which leaves two
 * jobs for the page, done here on every authenticated load:
 *
 *   1. Persist the session's user id as the device identity, so the
 *      service worker (which has no session of its own to ask) drains
 *      as the same person the page does.
 *   2. When that identity CHANGES, purge the read caches (features,
 *      forms, pick lists, tiles, geojson, cached pages: all fetched
 *      under the previous account's shares), then tell the new person
 *      about any unsynced rows the previous account left, and let them
 *      choose. Keeping them parks the rows, invisible to this account
 *      and drained when their owner signs back in. Removing them is the
 *      only path that deletes another person's captures, and it is a
 *      button, never a side effect of signing in.
 *
 * Session expiry alone does nothing here: `userId` is null while the
 * session is stale, and null is not an identity change. Sign-out
 * clears the identity itself (user-menu.tsx), so a different account
 * signing in after a clean sign-out sees the same dialog through the
 * "no previous identity but foreign rows exist" path.
 *
 * Mounted from AppShell, the one server component that already holds
 * `/users/me` for every page, so this runs on the field runtime (which
 * renders without the portal chrome) as well as everywhere else.
 */

import { useEffect, useState } from 'react';
import { CloudOff } from 'lucide-react';

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { clearUserCaches } from '@/components/user-menu';
import { useT } from '@/lib/i18n/locale-context';
import {
  describeForeignOfflineData,
  getOfflineIdentity,
  purgeCachedReadData,
  removeForeignOfflineData,
  setOfflineIdentity,
  type ForeignOfflineData,
} from '@/lib/offline-store';
import { toast } from '@/lib/toast';

interface Props {
  /** The signed-in account's portal user id, or null when there is no
   *  live session (anonymous, or the cookie is present but the tokens
   *  are dead). */
  userId: string | null;
}

export function OfflineIdentityGuard({ userId }: Props) {
  const t = useT();
  const [foreign, setForeign] = useState<ForeignOfflineData | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!userId) return;
    let cancelled = false;
    void (async () => {
      try {
        const previous = await getOfflineIdentity();
        if (previous === userId) return;
        // Persist FIRST. From this write on the service worker drains
        // as the new account, so the previous account's rows are
        // parked before anything else here has a chance to run; a
        // background sync firing during the dialog cannot send them.
        await setOfflineIdentity(userId);
        if (previous !== null) {
          // A different account was here and did not sign out (sign-out
          // would have cleared the identity and purged already). What
          // it fetched is not this account's to read.
          await purgeCachedReadData();
          await clearUserCaches();
        }
        const left = await describeForeignOfflineData(userId);
        if (cancelled) return;
        if (left.records + left.files > 0) setForeign(left);
      } catch {
        // IndexedDB refused (private mode, another tab holding an
        // upgrade). The drains carry their own ownership check, so a
        // failure here cannot cause a row to be sent under the wrong
        // account; it only means the question is asked on a later
        // load instead.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [userId]);

  if (!userId || !foreign) return null;

  const keep = () => setForeign(null);

  const remove = async () => {
    setBusy(true);
    try {
      const gone = await removeForeignOfflineData(userId);
      toast.success(
        t('fieldOffline.identityRemoved', {
          records: gone.records,
          files: gone.files,
        }),
      );
      setForeign(null);
    } catch (err) {
      toast.error(
        err instanceof Error && err.message
          ? err.message
          : t('fieldOffline.identityRemoveFailed'),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    // Dismissal (Escape, overlay click) is not a decision, so the
    // dialog stays until one of the two buttons is pressed. Both are
    // safe: Keep changes nothing, Remove is the one that deletes and
    // is labelled as such.
    <Dialog open onOpenChange={() => undefined}>
      <DialogContent size="md" hideCloseButton>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <CloudOff className="h-4 w-4 text-muted" />
            {t('fieldOffline.identityTitle')}
          </DialogTitle>
          <DialogDescription>
            {t('fieldOffline.identityBody', {
              records: foreign.records,
              files: foreign.files,
            })}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2 px-5 py-4 text-sm text-ink-1">
          <p>{t('fieldOffline.identityKeepExplain')}</p>
          <p>{t('fieldOffline.identityRemoveExplain')}</p>
        </div>
        <DialogFooter>
          <button
            type="button"
            disabled={busy}
            onClick={() => void remove()}
            className="rounded-md border border-danger/30 px-3 py-1.5 text-sm font-medium text-danger hover:bg-danger/10 disabled:opacity-60"
          >
            {t('fieldOffline.identityRemove')}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={keep}
            className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-foreground hover:bg-accent/90 disabled:opacity-60"
          >
            {t('fieldOffline.identityKeep')}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
