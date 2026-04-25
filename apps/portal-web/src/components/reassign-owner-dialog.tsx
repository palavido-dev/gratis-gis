'use client';

import { useState } from 'react';
import { Loader2, UserRound } from 'lucide-react';
import { PrincipalPicker, type PrincipalOption } from './principal-picker';

/**
 * Ownership-reassignment dialog.
 *
 * Used for:
 *   - single-item reassign from the item detail page
 *   - bulk reassign from the items list
 *   - admin-user-delete forced reassign
 *
 * The dialog itself is mechanical — it drives a user-picker, asks
 * the caller what access (if any) the previous owner should keep,
 * and calls back with the chosen userId + access option. The parent
 * component is responsible for the actual PATCH / bulk POST and the
 * "refresh after save" flow so the dialog doesn't need to know which
 * endpoint to hit.
 */
interface Props {
  /**
   * Label shown at the top. Free-form so callers can say
   * "Reassign Acme Buildings" or "Reassign 5 items".
   */
  heading: string;
  /** Sub-heading / context line, e.g. "Currently owned by alice". */
  subheading?: string;
  /** User ids to exclude from the picker (e.g. current owner). */
  excludeUserIds?: string[];
  saving: boolean;
  /**
   * Pre-selected owner shown above the picker. Typical use is "the
   * admin doing the reassign" — one-click confirmation for the
   * common case where the admin will take ownership themselves.
   * Null = no default.
   */
  defaultOwner?: { id: string; label: string } | null;
  onClose: () => void;
  onSubmit: (
    newOwnerId: string,
    keepPreviousOwnerAccess: 'view' | 'download' | 'edit' | 'admin' | null,
  ) => Promise<void> | void;
}

type KeepAccess = 'none' | 'view' | 'download' | 'edit' | 'admin';

export function ReassignOwnerDialog({
  heading,
  subheading,
  excludeUserIds = [],
  saving,
  defaultOwner = null,
  onClose,
  onSubmit,
}: Props) {
  // When the caller passes a default owner (e.g. "you" on the
  // admin-disable flow), pre-select it so the admin can just click
  // Reassign for the common case.
  const [pickedId, setPickedId] = useState<string | null>(
    defaultOwner?.id ?? null,
  );
  const [pickedLabel, setPickedLabel] = useState<string | null>(
    defaultOwner?.label ?? null,
  );
  const [keep, setKeep] = useState<KeepAccess>('view');
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setError(null);
    if (!pickedId) {
      setError('Pick the new owner.');
      return;
    }
    try {
      await onSubmit(pickedId, keep === 'none' ? null : keep);
    } catch (err) {
      setError((err as Error).message || 'Reassign failed');
    }
  }

  async function searchUsers(q: string): Promise<PrincipalOption[]> {
    const url = `/api/portal/users${q ? `?q=${encodeURIComponent(q)}` : ''}`;
    const res = await fetch(url);
    if (!res.ok) return [];
    const rows: Array<{
      id: string;
      username: string;
      fullName: string;
      avatarUrl: string | null;
    }> = await res.json();
    const excluded = new Set(excludeUserIds);
    return rows
      .filter((u) => !excluded.has(u.id))
      .map((u) => ({
        id: u.id,
        title: u.fullName || u.username,
        subtitle: u.username,
        imageUrl: u.avatarUrl,
      }));
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md space-y-4 rounded-lg border border-border bg-surface-1 p-4 shadow-raised"
      >
        <div className="flex items-center gap-2">
          <UserRound className="h-5 w-5 text-accent" />
          <div>
            <h2 className="text-lg font-semibold">{heading}</h2>
            {subheading ? (
              <p className="text-xs text-muted">{subheading}</p>
            ) : null}
          </div>
        </div>

        <div>
          <label className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-muted">
            New owner
          </label>
          <PrincipalPicker
            placeholder="Search a user in your organization…"
            search={searchUsers}
            onPick={(p) => {
              setPickedId(p.id);
              setPickedLabel(p.title);
            }}
          />
          {pickedId ? (
            <p className="mt-1 text-[11px] text-ink-1">
              Transfer to <span className="font-medium">{pickedLabel}</span>
            </p>
          ) : null}
        </div>

        <fieldset className="space-y-1">
          <legend className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted">
            Keep previous owner&apos;s access
          </legend>
          {(
            [
              {
                value: 'view',
                label: 'View: previous owner can still see it',
              },
              {
                value: 'download',
                label: 'Download: previous owner can also export raw data',
              },
              {
                value: 'edit',
                label: 'Edit: previous owner can still change it',
              },
              {
                value: 'admin',
                label: 'Admin: previous owner keeps full control',
              },
              {
                value: 'none',
                label: 'None: previous owner loses access',
              },
            ] as Array<{ value: KeepAccess; label: string }>
          ).map((opt) => (
            <label
              key={opt.value}
              className="flex items-start gap-2 text-xs text-ink-1"
            >
              <input
                type="radio"
                name="keep"
                value={opt.value}
                checked={keep === opt.value}
                onChange={() => setKeep(opt.value)}
                className="mt-0.5"
              />
              {opt.label}
            </label>
          ))}
        </fieldset>

        {error ? (
          <p role="alert" className="text-xs text-danger">
            {error}
          </p>
        ) : null}

        <div className="flex items-center justify-end gap-2 pt-1">
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            className="h-9 rounded-md border border-border bg-surface-1 px-3 text-xs font-medium text-ink-1 hover:bg-surface-2 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={saving || !pickedId}
            className="inline-flex h-9 items-center gap-1.5 rounded-md bg-accent px-3 text-xs font-medium text-accent-foreground hover:opacity-90 disabled:opacity-50"
          >
            {saving ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <UserRound className="h-3.5 w-3.5" />
            )}
            Reassign
          </button>
        </div>
      </div>
    </div>
  );
}
