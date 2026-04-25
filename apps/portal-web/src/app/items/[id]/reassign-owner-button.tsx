'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { UserRound } from 'lucide-react';
import { ReassignOwnerDialog } from '@/components/reassign-owner-dialog';

/**
 * Thin client-side wrapper rendered in the item detail-page header
 * next to Edit / Delete. Clicking it opens the reassignment dialog;
 * the dialog calls back into this component's submit handler which
 * posts to /api/portal/items/:id/owner and refreshes the page so
 * the header + list views reflect the new owner.
 */
interface Props {
  itemId: string;
  itemTitle: string;
  currentOwnerId: string;
  currentOwnerLabel: string;
}

export function ReassignOwnerButton({
  itemId,
  itemTitle,
  currentOwnerId,
  currentOwnerLabel,
}: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [, startTransition] = useTransition();

  async function submit(
    newOwnerId: string,
    keepPreviousOwnerAccess: 'view' | 'download' | 'edit' | 'admin' | null,
  ) {
    setSaving(true);
    try {
      const res = await fetch(`/api/portal/items/${itemId}/owner`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ newOwnerId, keepPreviousOwnerAccess }),
      });
      if (!res.ok) {
        throw new Error(
          `Reassign failed: ${res.status} ${await res.text().catch(() => '')}`,
        );
      }
      setOpen(false);
      startTransition(() => router.refresh());
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title="Reassign owner"
        className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-surface-1 px-2.5 text-xs font-medium text-ink-1 shadow-card hover:bg-surface-2"
      >
        <UserRound className="h-3.5 w-3.5" />
        Reassign
      </button>
      {open ? (
        <ReassignOwnerDialog
          heading={`Reassign ${itemTitle}`}
          subheading={`Currently owned by ${currentOwnerLabel}`}
          excludeUserIds={[currentOwnerId]}
          saving={saving}
          onClose={() => setOpen(false)}
          onSubmit={submit}
        />
      ) : null}
    </>
  );
}
