'use client';

import { useCallback, useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Trash2, User as UserIcon } from 'lucide-react';
import type { GroupMember, User } from '@gratis-gis/shared-types';
import {
  PrincipalPicker,
  type PrincipalOption,
} from '@/components/principal-picker';
import { ConfirmDialog } from '@/components/confirm-dialog';

type MemberWithUser = GroupMember & {
  user?: Pick<User, 'id' | 'username' | 'fullName'> & {
    avatarUrl?: string | null;
  };
};

interface Props {
  groupId: string;
  initialMembers: MemberWithUser[];
  canManage: boolean;
  /** Caller id; lets us detect "removing self" and show a more
   *  detailed confirm than the generic remove-member flow (#102). */
  currentUserId: string;
  /** Whether the caller is the group's owner. Drives the extra
   *  warning copy when the owner removes themselves -- they keep
   *  ownership but lose member-only visibility. */
  isOwner: boolean;
}

/**
 * Membership management for a group. Admins and group owners can add or
 * remove members; everyone else sees a read-only roster.
 *
 * Add flow uses the same org-scoped `/users?q=` search the sharing
 * panel uses, so names + avatars show up instead of raw UUIDs.
 * Already-added users get greyed out in the picker with an
 * "already a member" tooltip.
 *
 * Backend endpoints:
 *   POST   /api/groups/:id/members      { userId, role? }
 *   DELETE /api/groups/:id/members/:userId
 */
export function MembersPanel({
  groupId,
  initialMembers,
  canManage,
  currentUserId,
  isOwner,
}: Props) {
  const router = useRouter();
  const [members, setMembers] = useState(initialMembers);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [addingRole, setAddingRole] = useState<'member' | 'admin'>('member');
  // Self-removal confirm dialog state (#102). Holds the row the
  // user clicked the trash button on; the dialog only renders
  // when this is set so the rich tailored copy doesn't trigger
  // for ordinary "remove someone else" flows.
  const [confirmingSelfRemoval, setConfirmingSelfRemoval] =
    useState<MemberWithUser | null>(null);

  const memberIds = useMemo(
    () => new Set<string>(members.map((m) => String(m.userId))),
    [members],
  );

  // Search users via the org directory. Already-member rows come
  // back disabled so the picker can grey them out.
  const searchUsers = useCallback(
    async (q: string): Promise<PrincipalOption[]> => {
      const url = `/api/portal/users${q ? `?q=${encodeURIComponent(q)}` : ''}`;
      const res = await fetch(url);
      if (!res.ok) return [];
      const rows: Array<{
        id: string;
        username: string;
        fullName: string | null;
        avatarUrl: string | null;
      }> = await res.json();
      return rows.map((u) => {
        const already = memberIds.has(u.id);
        const opt: PrincipalOption = {
          id: u.id,
          title: u.fullName || u.username,
          subtitle: u.username,
          imageUrl: u.avatarUrl,
        };
        if (already) {
          opt.disabled = true;
          opt.disabledReason = 'already a member';
        }
        return opt;
      });
    },
    [memberIds],
  );

  async function addMember(pick: PrincipalOption) {
    setError(null);
    if (memberIds.has(pick.id)) return;
    const res = await fetch(`/api/portal/groups/${groupId}/members`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userId: pick.id, role: addingRole }),
    });
    if (!res.ok) {
      setError(`Add failed: ${res.status} ${await res.text()}`);
      return;
    }
    const added: GroupMember = await res.json();
    // The POST returns just the GroupMember row with no joined user
    // metadata, so a naive append rendered the row as "bbbbbbbb"
    // (userId.slice(0,8)) until router.refresh() round-tripped the
    // joined shape. Synthesize the user fields here from the picker's
    // option so the new row paints with the right name immediately.
    // Username is in `subtitle`; fullName lives in `title` (the
    // picker's display label is fullName || username).
    const enriched: MemberWithUser = {
      ...added,
      user: {
        id: pick.id as User['id'],
        username: pick.subtitle ?? pick.title,
        fullName: pick.title,
        avatarUrl: pick.imageUrl ?? null,
      },
    };
    setMembers((cur) => {
      const filtered = cur.filter((m) => String(m.userId) !== String(added.userId));
      return [...filtered, enriched];
    });
    // Still refresh so any other server-joined data (added timestamp
    // formatting, etc) catches up; the row label is correct as soon
    // as setMembers commits.
    startTransition(() => router.refresh());
  }

  function removeMember(member: MemberWithUser) {
    setError(null);
    // Self-removal opens the styled confirm dialog (#102). Removing
    // someone else is a single-click action; only the "remove
    // myself" path needs the rich tailored explanation.
    const removingSelf = String(member.userId) === currentUserId;
    if (removingSelf) {
      setConfirmingSelfRemoval(member);
      return;
    }
    void performRemoveMember(member);
  }

  async function performRemoveMember(member: MemberWithUser) {
    setError(null);
    const res = await fetch(
      `/api/portal/groups/${groupId}/members/${member.userId}`,
      { method: 'DELETE' },
    );
    if (!res.ok) {
      setError(`Remove failed: ${res.status} ${await res.text()}`);
      return;
    }
    setMembers((cur) => cur.filter((m) => m.userId !== member.userId));
    startTransition(() => router.refresh());
  }

  return (
    <div className="rounded-lg border border-border bg-surface-1 shadow-card">
      {members.length === 0 ? (
        <p className="px-4 py-6 text-sm text-muted">
          No members yet.
          {canManage ? ' Add one below.' : ''}
        </p>
      ) : (
        <ul className="divide-y divide-border">
          {members.map((m) => (
            <li
              key={m.userId}
              className="flex items-center justify-between px-4 py-3"
            >
              <div className="flex items-center gap-3">
                <UserIcon className="h-4 w-4 text-muted" />
                <div>
                  <div className="text-sm font-medium text-ink-1">
                    {m.user?.fullName ??
                      m.user?.username ??
                      m.userId.slice(0, 8)}
                  </div>
                  <div className="text-xs text-muted">{m.role}</div>
                </div>
              </div>
              {canManage ? (
                <button
                  type="button"
                  onClick={() => removeMember(m)}
                  disabled={pending}
                  className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted hover:bg-surface-2 hover:text-danger disabled:opacity-50"
                  aria-label="Remove member"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      {canManage ? (
        <div className="space-y-2 border-t border-border p-4">
          <div className="flex items-center gap-2">
            <div className="min-w-0 flex-1">
              <PrincipalPicker
                placeholder="Search users to add..."
                search={searchUsers}
                onPick={(opt) => void addMember(opt)}
                emptyMessage="No matching users."
                emptyInitialMessage="Start typing a name or username."
              />
            </div>
            <select
              value={addingRole}
              onChange={(e) =>
                setAddingRole(e.target.value as 'member' | 'admin')
              }
              className="h-9 shrink-0 rounded-md border border-border bg-surface-1 px-2 text-sm focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30"
              title="Role the user joins as"
            >
              <option value="member">member</option>
              <option value="admin">admin</option>
            </select>
          </div>
          <p className="text-[11px] text-muted">
            Pick a user from the directory to add them as a{' '}
            <span className="font-medium">{addingRole}</span>. Existing
            members are greyed out.
          </p>
          {error ? (
            <p className="text-sm text-danger" role="alert">
              {error}
            </p>
          ) : null}
        </div>
      ) : null}

      {/* Self-removal confirm (#102). Styled dialog with copy
          tailored to whether the caller owns the group: owners
          keep a lot after removing themselves and need to know
          exactly what changes; non-owner members get a shorter
          warning. */}
      <ConfirmDialog
        open={confirmingSelfRemoval !== null}
        onCancel={() => setConfirmingSelfRemoval(null)}
        onConfirm={async () => {
          const m = confirmingSelfRemoval;
          if (!m) return;
          setConfirmingSelfRemoval(null);
          await performRemoveMember(m);
        }}
        title="Remove yourself from this group?"
        confirmLabel="Remove me"
        tone="danger"
      >
        {isOwner ? (
          <div className="space-y-3 text-sm text-ink-1">
            <div>
              <p className="mb-1 font-medium">You&apos;ll keep:</p>
              <ul className="list-disc space-y-0.5 pl-5 text-muted">
                <li>Ownership of the group</li>
                <li>The ability to add/remove members and edit it</li>
                <li>The ability to share items TO the group</li>
              </ul>
            </div>
            <div>
              <p className="mb-1 font-medium">You&apos;ll lose:</p>
              <ul className="list-disc space-y-0.5 pl-5 text-muted">
                <li>
                  Visibility into items shared TO the group through your
                  personal access (member-only path).
                </li>
              </ul>
            </div>
            <p className="text-xs text-muted">
              You can re-add yourself at any time.
            </p>
          </div>
        ) : (
          <p className="text-sm text-ink-1">
            You&apos;ll lose access to items shared with this group. A
            group admin will need to re-add you to get back in.
          </p>
        )}
      </ConfirmDialog>
    </div>
  );
}
