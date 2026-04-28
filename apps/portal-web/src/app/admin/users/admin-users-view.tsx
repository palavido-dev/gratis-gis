'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  Check,
  Eye,
  KeyRound,
  Loader2,
  MailPlus,
  Pencil,
  Plus,
  RotateCcw,
  Save,
  Search,
  ShieldCheck,
  Trash2,
  UserMinus,
  UserPlus,
} from 'lucide-react';
import type { AdminUserRow } from './page';
import { ReassignOwnerDialog } from '@/components/reassign-owner-dialog';
import { ShareExpiryPicker } from '@/components/share-expiry-picker';
import { UserAccessDialog } from './user-access-dialog';

/**
 * Admin-side users table.
 *
 * All mutations go through the portal-api's /api/admin/users/*
 * endpoints, which proxy to Keycloak's Admin REST API after
 * AdminGuard confirms the caller's orgRole === 'admin'.
 *
 * Invite flow: POST to /api/admin/users with sendSetupEmail:true.
 * Keycloak sends the UPDATE_PASSWORD + VERIFY_EMAIL email. The
 * invitee establishes their password via that link: we never
 * handle raw passwords.
 */
type OrgRole = 'viewer' | 'contributor' | 'admin';

interface Props {
  initialUsers: AdminUserRow[];
}

export function AdminUsersView({ initialUsers }: Props) {
  const [users, setUsers] = useState<AdminUserRow[]>(initialUsers);
  const [query, setQuery] = useState('');
  const [inviteOpen, setInviteOpen] = useState(false);
  const [editing, setEditing] = useState<AdminUserRow | null>(null);
  // "View access" dialog target (#89). Separate from `editing` so
  // an admin can have one of each open without contention.
  const [viewingAccess, setViewingAccess] = useState<AdminUserRow | null>(null);
  const [working, setWorking] = useState<string | null>(null); // keyed by user id
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  // When a delete is blocked by owned items, stash the target + item
  // count here so the reassign dialog can render above the table.
  const [deleteWithItems, setDeleteWithItems] = useState<{
    user: AdminUserRow;
    items: Array<{ id: string; title: string; type: string }>;
  } | null>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return users;
    return users.filter((u) => {
      const hay = [
        u.username,
        u.email,
        u.firstName,
        u.lastName,
        u.fullName,
      ]
        .filter((s): s is string => typeof s === 'string')
        .join(' ')
        .toLowerCase();
      return hay.includes(q);
    });
  }, [query, users]);

  const flash = useCallback((msg: string) => {
    setToast(msg);
    setTimeout(() => setToast((curr) => (curr === msg ? null : curr)), 2500);
  }, []);

  async function refresh() {
    try {
      const res = await fetch('/api/portal/admin/users?max=200');
      if (!res.ok) return;
      const rows = (await res.json()) as AdminUserRow[];
      setUsers(rows);
    } catch {
      /* non-fatal: the list stays as-is */
    }
  }

  async function setEnabled(user: AdminUserRow, enabled: boolean) {
    setWorking(user.id);
    setError(null);
    const res = await fetch(`/api/portal/admin/users/${user.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled }),
    });
    setWorking(null);
    if (!res.ok) {
      setError(
        `Could not ${enabled ? 'enable' : 'disable'} ${user.username}: ${res.status}`,
      );
      return;
    }
    setUsers((prev) =>
      prev.map((u) => (u.id === user.id ? { ...u, enabled } : u)),
    );
    flash(`${user.username} ${enabled ? 'enabled' : 'disabled'}`);
  }

  async function setRole(user: AdminUserRow, orgRole: OrgRole) {
    setWorking(user.id);
    setError(null);
    const res = await fetch(`/api/portal/admin/users/${user.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ orgRole }),
    });
    setWorking(null);
    if (!res.ok) {
      setError(`Could not change role for ${user.username}: ${res.status}`);
      return;
    }
    setUsers((prev) =>
      prev.map((u) =>
        u.id === user.id
          ? {
              ...u,
              attributes: { ...(u.attributes ?? {}), org_role: [orgRole] },
            }
          : u,
      ),
    );
    flash(`${user.username} role set to ${orgRole}`);
  }

  /**
   * Actual delete call: assumes the caller has already verified the
   * user has no owned items (or has reassigned them). Called either
   * directly (clean path) or from the reassign-and-delete flow below.
   */
  async function performDelete(user: AdminUserRow) {
    setWorking(user.id);
    setError(null);
    const res = await fetch(`/api/portal/admin/users/${user.id}`, {
      method: 'DELETE',
    });
    setWorking(null);
    if (!res.ok) {
      setError(`Delete failed: ${res.status}`);
      return;
    }
    setUsers((prev) => prev.filter((u) => u.id !== user.id));
    flash(`${user.username} deleted`);
  }

  async function removeUser(user: AdminUserRow) {
    setError(null);
    // Preflight: does this user own anything? If so, refuse to delete
    // until the admin reassigns: otherwise their items would lose
    // their owner pointer (FK is set-null-deferred in Prisma, but
    // "orphaned content" is a worse UX than "please pick a new owner").
    setWorking(user.id);
    try {
      const res = await fetch(
        `/api/portal/items?ownerId=${encodeURIComponent(user.id)}`,
      );
      if (!res.ok) {
        setError(`Could not check owned items: ${res.status}`);
        return;
      }
      const owned = (await res.json()) as Array<{
        id: string;
        title: string;
        type: string;
      }>;
      if (owned.length > 0) {
        // Stash and let the dialog drive reassign-then-delete.
        setDeleteWithItems({ user, items: owned });
        return;
      }
    } finally {
      setWorking(null);
    }
    if (
      !confirm(
        `Permanently delete ${user.username}? This cannot be undone and will remove their portal account.`,
      )
    ) {
      return;
    }
    await performDelete(user);
  }

  /**
   * Handler for the reassign-then-delete dialog. Does the bulk
   * reassign in one call, then the delete.
   */
  async function reassignAndDelete(
    newOwnerId: string,
    keepPreviousOwnerAccess: 'view' | 'download' | 'edit' | 'admin' | null,
  ) {
    if (!deleteWithItems) return;
    setError(null);
    const res = await fetch('/api/portal/items/bulk/reassign-owner', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        itemIds: deleteWithItems.items.map((i) => i.id),
        newOwnerId,
        keepPreviousOwnerAccess,
      }),
    });
    if (!res.ok) {
      setError(`Reassign failed: ${res.status} ${await res.text().catch(() => '')}`);
      return;
    }
    const userToDelete = deleteWithItems.user;
    setDeleteWithItems(null);
    flash(
      `Reassigned ${userToDelete.username}'s ${deleteWithItems.items.length} item${
        deleteWithItems.items.length === 1 ? '' : 's'
      }. Deleting account…`,
    );
    await performDelete(userToDelete);
  }

  async function sendReset(user: AdminUserRow) {
    if (!user.email) {
      setError(`${user.username} has no email on file.`);
      return;
    }
    setWorking(user.id);
    setError(null);
    const res = await fetch(
      `/api/portal/admin/users/${user.id}/reset-password`,
      { method: 'POST' },
    );
    setWorking(null);
    if (!res.ok) {
      setError(`Could not send reset email: ${res.status}`);
      return;
    }
    flash(`Reset email sent to ${user.email}`);
  }

  function onInvited(created: AdminUserRow) {
    setUsers((prev) => [created, ...prev]);
    setInviteOpen(false);
    flash(`${created.username} invited`);
    // Pull fresh data so any extra fields Keycloak sets on create
    // (emailVerified flag, etc.) are reflected.
    void refresh();
  }

  function onEdited(updated: AdminUserRow) {
    setUsers((prev) =>
      prev.map((u) => (u.id === updated.id ? { ...u, ...updated } : u)),
    );
    setEditing(null);
    flash(`${updated.username} updated`);
  }

  return (
    <div>
      {/* Toolbar */}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <label className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted" />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by name, email, or username..."
            className="h-9 w-full rounded-md border border-border bg-surface-1 pl-8 pr-3 text-sm text-ink-1 focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30"
          />
        </label>
        <button
          type="button"
          onClick={() => setInviteOpen(true)}
          className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-md bg-accent px-3 text-sm font-medium text-accent-foreground shadow-card hover:opacity-90"
        >
          <Plus className="h-4 w-4" />
          Invite user
        </button>
      </div>

      {error ? (
        <div
          role="alert"
          className="mb-3 flex items-start gap-2 rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger"
        >
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{error}</span>
        </div>
      ) : null}
      {toast ? (
        <div className="mb-3 inline-flex items-center gap-1 rounded-md border border-success/30 bg-success/10 px-2 py-1 text-xs text-success">
          <Check className="h-3.5 w-3.5" />
          {toast}
        </div>
      ) : null}

      {/* Table */}
      <div className="overflow-hidden rounded-lg border border-border bg-surface-1">
        <table className="w-full text-sm">
          <thead className="bg-surface-2 text-xs text-muted">
            <tr>
              <th className="px-3 py-2 text-left font-medium">Name</th>
              <th className="px-3 py-2 text-left font-medium">Username</th>
              <th className="px-3 py-2 text-left font-medium">Email</th>
              <th className="px-3 py-2 text-left font-medium">Role</th>
              <th className="px-3 py-2 text-left font-medium">Last login</th>
              <th className="px-3 py-2 text-left font-medium">Status</th>
              <th className="px-3 py-2 text-right font-medium">Actions</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr>
                <td
                  colSpan={7}
                  className="px-3 py-8 text-center text-sm text-muted"
                >
                  {users.length === 0
                    ? 'No users yet. Invite one to get started.'
                    : 'No users match your search.'}
                </td>
              </tr>
            ) : (
              filtered.map((u) => {
                const role = (u.attributes?.org_role?.[0] ?? 'viewer') as OrgRole;
                const busy = working === u.id;
                return (
                  <tr key={u.id} className="border-t border-border">
                    <td className="px-3 py-2">
                      <p className="font-medium text-ink-0">
                        {u.fullName || u.username}
                      </p>
                    </td>
                    <td className="px-3 py-2 font-mono text-xs text-muted">
                      {u.username}
                    </td>
                    <td className="px-3 py-2 text-xs text-ink-1">
                      {u.email ?? (
                        <span className="text-muted italic">-</span>
                      )}
                      {u.emailVerified ? (
                        <span className="ml-1 inline-flex items-center gap-0.5 text-[10px] text-success">
                          <ShieldCheck className="h-3 w-3" />
                          verified
                        </span>
                      ) : null}
                    </td>
                    <td className="px-3 py-2">
                      <select
                        value={role}
                        disabled={busy}
                        onChange={(e) =>
                          void setRole(u, e.target.value as OrgRole)
                        }
                        className="h-7 rounded border border-border bg-surface-1 px-1 text-xs focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/30 disabled:opacity-50"
                      >
                        <option value="viewer">viewer</option>
                        <option value="contributor">contributor</option>
                        <option value="admin">admin</option>
                      </select>
                    </td>
                    <td className="px-3 py-2 text-xs text-muted">
                      {u.lastSeenAt ? (
                        <span title={new Date(u.lastSeenAt).toISOString()}>
                          {formatRelative(u.lastSeenAt)}
                        </span>
                      ) : (
                        <span className="italic">Never</span>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      {u.enabled ? (
                        <span className="inline-flex items-center gap-1 rounded bg-success/10 px-1.5 py-0.5 text-[11px] text-success">
                          Active
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 rounded bg-muted/20 px-1.5 py-0.5 text-[11px] text-muted">
                          Disabled
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex items-center justify-end gap-1">
                        <button
                          type="button"
                          onClick={() => setViewingAccess(u)}
                          disabled={busy}
                          title="See everything this user has access to"
                          className="inline-flex h-7 items-center gap-1 rounded border border-border bg-surface-1 px-2 text-[11px] text-ink-1 hover:bg-surface-2 disabled:opacity-50"
                        >
                          <Eye className="h-3 w-3" />
                          Access
                        </button>
                        <button
                          type="button"
                          onClick={() => setEditing(u)}
                          disabled={busy}
                          title="Edit name / email"
                          className="inline-flex h-7 items-center gap-1 rounded border border-border bg-surface-1 px-2 text-[11px] text-ink-1 hover:bg-surface-2 disabled:opacity-50"
                        >
                          <Pencil className="h-3 w-3" />
                          Edit
                        </button>
                        <button
                          type="button"
                          onClick={() => void sendReset(u)}
                          disabled={busy}
                          title="Send password-reset email"
                          className="inline-flex h-7 items-center gap-1 rounded border border-border bg-surface-1 px-2 text-[11px] text-ink-1 hover:bg-surface-2 disabled:opacity-50"
                        >
                          {busy ? (
                            <Loader2 className="h-3 w-3 animate-spin" />
                          ) : (
                            <KeyRound className="h-3 w-3" />
                          )}
                          Reset
                        </button>
                        <button
                          type="button"
                          onClick={() => void setEnabled(u, !u.enabled)}
                          disabled={busy}
                          title={u.enabled ? 'Disable user' : 'Enable user'}
                          className="inline-flex h-7 w-7 items-center justify-center rounded border border-border bg-surface-1 text-muted hover:bg-surface-2 hover:text-ink-1 disabled:opacity-50"
                        >
                          <UserMinus className="h-3 w-3" />
                        </button>
                        <button
                          type="button"
                          onClick={() => void removeUser(u)}
                          disabled={busy}
                          title="Delete user (permanent)"
                          className="inline-flex h-7 w-7 items-center justify-center rounded border border-border bg-surface-1 text-muted hover:bg-danger/10 hover:text-danger disabled:opacity-50"
                        >
                          <Trash2 className="h-3 w-3" />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {inviteOpen ? (
        <InviteUserDialog
          onClose={() => setInviteOpen(false)}
          onInvited={onInvited}
        />
      ) : null}

      {editing ? (
        <EditUserDialog
          user={editing}
          onClose={() => setEditing(null)}
          onSaved={onEdited}
        />
      ) : null}

      {viewingAccess ? (
        <UserAccessDialog
          userId={viewingAccess.id}
          username={viewingAccess.username}
          onClose={() => setViewingAccess(null)}
        />
      ) : null}

      {deleteWithItems ? (
        <ReassignOwnerDialog
          heading={`Reassign ${deleteWithItems.user.username}'s items`}
          subheading={`${deleteWithItems.items.length} item${
            deleteWithItems.items.length === 1 ? '' : 's'
          } must move to another user before this account can be deleted.`}
          excludeUserIds={[deleteWithItems.user.id]}
          saving={working === deleteWithItems.user.id}
          onClose={() => setDeleteWithItems(null)}
          onSubmit={reassignAndDelete}
        />
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------

interface InviteDialogProps {
  onClose: () => void;
  onInvited: (created: AdminUserRow) => void;
}

function InviteUserDialog({ onClose, onInvited }: InviteDialogProps) {
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [orgRole, setOrgRole] = useState<OrgRole>('viewer');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (username.trim().length < 2) {
      setError('Username must be at least 2 characters.');
      return;
    }
    if (!email.includes('@')) {
      setError('Please enter a valid email address.');
      return;
    }
    setSubmitting(true);
    const res = await fetch('/api/portal/admin/users', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        username: username.trim(),
        email: email.trim(),
        firstName: firstName.trim() || undefined,
        lastName: lastName.trim() || undefined,
        orgRole,
        sendSetupEmail: true,
      }),
    });
    setSubmitting(false);
    if (!res.ok) {
      setError(`Invite failed: ${res.status} ${await res.text()}`);
      return;
    }
    const created = (await res.json()) as AdminUserRow;
    // setupEmailError means: user exists in Keycloak, but password-
    // setup email could not be sent (usually realm SMTP misconfigured).
    // Confirm with the admin so they're not surprised when the user
    // says "I didn't get an email". The user row is still added.
    if (created.setupEmailError) {
      // eslint-disable-next-line no-alert
      window.alert(
        `User "${created.username}" was created, but the password-setup ` +
          `email could not be sent:\n\n${created.setupEmailError}\n\n` +
          `Once SMTP is healthy, click "Reset password" on this user to ` +
          `re-send the email.`,
      );
    }
    onInvited(created);
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-30 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <form
        onSubmit={submit}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md space-y-3 rounded-lg border border-border bg-surface-1 p-4 shadow-raised"
      >
        <div className="flex items-center gap-2">
          <UserPlus className="h-5 w-5 text-accent" />
          <h2 className="text-lg font-semibold">Invite user</h2>
        </div>
        <p className="text-xs text-muted">
          We&apos;ll send a password-setup email from the portal. The user
          establishes their own password through that link -{' '}
          <span className="font-medium">no passwords are set here</span>.
        </p>

        <label className="block text-xs">
          <span className="mb-1 block uppercase tracking-wide text-muted">
            Username
          </span>
          <input
            type="text"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="alice"
            required
            className="h-9 w-full rounded-md border border-border bg-surface-1 px-2 font-mono text-xs focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30"
          />
        </label>
        <label className="block text-xs">
          <span className="mb-1 block uppercase tracking-wide text-muted">
            Email
          </span>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="alice@example.com"
            required
            className="h-9 w-full rounded-md border border-border bg-surface-1 px-2 text-xs focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30"
          />
        </label>
        <div className="grid grid-cols-2 gap-2">
          <label className="block text-xs">
            <span className="mb-1 block uppercase tracking-wide text-muted">
              First name
            </span>
            <input
              type="text"
              value={firstName}
              onChange={(e) => setFirstName(e.target.value)}
              className="h-9 w-full rounded-md border border-border bg-surface-1 px-2 text-xs focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30"
            />
          </label>
          <label className="block text-xs">
            <span className="mb-1 block uppercase tracking-wide text-muted">
              Last name
            </span>
            <input
              type="text"
              value={lastName}
              onChange={(e) => setLastName(e.target.value)}
              className="h-9 w-full rounded-md border border-border bg-surface-1 px-2 text-xs focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30"
            />
          </label>
        </div>
        <label className="block text-xs">
          <span className="mb-1 block uppercase tracking-wide text-muted">
            Role
          </span>
          <select
            value={orgRole}
            onChange={(e) => setOrgRole(e.target.value as OrgRole)}
            className="h-9 w-full rounded-md border border-border bg-surface-1 px-2 text-xs focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30"
          >
            <option value="viewer">viewer: read content they have access to</option>
            <option value="contributor">contributor: can create/edit content</option>
            <option value="admin">admin: full access, including this page</option>
          </select>
        </label>

        {error ? (
          <p className="text-xs text-danger" role="alert">
            {error}
          </p>
        ) : null}

        <div className="flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="h-9 rounded-md border border-border bg-surface-1 px-3 text-xs font-medium text-ink-1 hover:bg-surface-2 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={submitting}
            className="inline-flex h-9 items-center gap-1.5 rounded-md bg-accent px-3 text-xs font-medium text-accent-foreground hover:opacity-90 disabled:opacity-50"
          >
            {submitting ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <MailPlus className="h-3.5 w-3.5" />
            )}
            Send invite
          </button>
        </div>
      </form>
    </div>
  );
}

// ---------------------------------------------------------------------------

interface EditDialogProps {
  user: AdminUserRow;
  onClose: () => void;
  onSaved: (updated: AdminUserRow) => void;
}

/**
 * Inline edit dialog for admin-side user mutations. Username is
 * intentionally immutable: Keycloak supports renames but downstream
 * item.createdById references are keyed by user id anyway, and letting
 * admins rename usernames invites impersonation footguns. Email and
 * display name are the common "please update my record" fields.
 */
function EditUserDialog({ user, onClose, onSaved }: EditDialogProps) {
  const [email, setEmail] = useState(user.email ?? '');
  const [firstName, setFirstName] = useState(user.firstName ?? '');
  const [lastName, setLastName] = useState(user.lastName ?? '');
  const [orgRole, setOrgRole] = useState<OrgRole>(
    (user.attributes?.org_role?.[0] as OrgRole | undefined) ?? 'viewer',
  );
  const [enabled, setEnabled] = useState(Boolean(user.enabled));
  const [autoDisableAt, setAutoDisableAt] = useState<string | null>(
    user.autoDisableAt ?? null,
  );
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!email.includes('@')) {
      setError('Please enter a valid email address.');
      return;
    }
    // Only send fields that actually changed. Keycloak tolerates full
    // PUTs, but narrowing the patch makes audit logs much easier to
    // read and avoids accidental clobbers when we add fields later.
    const patch: Record<string, unknown> = {};
    if (email.trim() !== (user.email ?? '')) patch.email = email.trim();
    if (firstName.trim() !== (user.firstName ?? ''))
      patch.firstName = firstName.trim();
    if (lastName.trim() !== (user.lastName ?? ''))
      patch.lastName = lastName.trim();
    if (
      orgRole !==
      ((user.attributes?.org_role?.[0] as OrgRole | undefined) ?? 'viewer')
    ) {
      patch.orgRole = orgRole;
    }
    if (enabled !== Boolean(user.enabled)) patch.enabled = enabled;
    if (autoDisableAt !== (user.autoDisableAt ?? null)) {
      patch.autoDisableAt = autoDisableAt;
    }

    if (Object.keys(patch).length === 0) {
      // Nothing to save: just close. Avoids spurious PATCH round-trips
      // that would re-render the row with an identical "updated" flash.
      onClose();
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch(`/api/portal/admin/users/${user.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(patch),
      });
      if (!res.ok) {
        setError(
          `Save failed: ${res.status} ${await res.text().catch(() => '')}`,
        );
        return;
      }
      const updated = (await res.json()) as AdminUserRow;
      onSaved(updated);
    } catch (err) {
      setError((err as Error).message || 'Save failed');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-30 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <form
        onSubmit={submit}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md space-y-3 rounded-lg border border-border bg-surface-1 p-4 shadow-raised"
      >
        <div className="flex items-center gap-2">
          <Pencil className="h-5 w-5 text-accent" />
          <h2 className="text-lg font-semibold">Edit user</h2>
        </div>
        <p className="text-xs text-muted">
          Editing{' '}
          <span className="font-mono text-ink-1">{user.username}</span>. Username
          can&apos;t be changed here: it&apos;s used as the stable identifier
          for content this user created.
        </p>

        <div className="grid grid-cols-2 gap-2">
          <label className="block text-xs">
            <span className="mb-1 block uppercase tracking-wide text-muted">
              First name
            </span>
            <input
              type="text"
              value={firstName}
              onChange={(e) => setFirstName(e.target.value)}
              className="h-9 w-full rounded-md border border-border bg-surface-1 px-2 text-xs focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30"
            />
          </label>
          <label className="block text-xs">
            <span className="mb-1 block uppercase tracking-wide text-muted">
              Last name
            </span>
            <input
              type="text"
              value={lastName}
              onChange={(e) => setLastName(e.target.value)}
              className="h-9 w-full rounded-md border border-border bg-surface-1 px-2 text-xs focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30"
            />
          </label>
        </div>

        <label className="block text-xs">
          <span className="mb-1 block uppercase tracking-wide text-muted">
            Email
          </span>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            className="h-9 w-full rounded-md border border-border bg-surface-1 px-2 text-xs focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30"
          />
          {user.emailVerified && email.trim() !== (user.email ?? '') ? (
            <span className="mt-1 block text-[11px] text-warning">
              Changing the email will reset the verified flag: the user will
              need to re-verify.
            </span>
          ) : null}
        </label>

        <label className="block text-xs">
          <span className="mb-1 block uppercase tracking-wide text-muted">
            Role
          </span>
          <select
            value={orgRole}
            onChange={(e) => setOrgRole(e.target.value as OrgRole)}
            className="h-9 w-full rounded-md border border-border bg-surface-1 px-2 text-xs focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30"
          >
            <option value="viewer">viewer</option>
            <option value="contributor">contributor</option>
            <option value="admin">admin</option>
          </select>
        </label>

        <label className="flex items-center gap-2 text-xs">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
            className="h-3.5 w-3.5 rounded border-border text-accent focus:ring-accent/30"
          />
          <span className="text-ink-1">
            Account active{' '}
            <span className="text-muted">
              (disabled accounts can&apos;t sign in)
            </span>
          </span>
        </label>

        {/* Auto-disable (#85). Sets a hard end-date on the
            account; auth-sync rejects requests once the date
            passes and the housekeeping cron flips Keycloak's
            enabled flag in bulk. Refused for org admins to
            avoid lockout (the picker is hidden when the role
            is admin). */}
        {orgRole !== 'admin' ? (
          <div className="text-xs">
            <span className="mb-1 block uppercase tracking-wide text-muted">
              Auto-disable on
            </span>
            <ShareExpiryPicker
              value={autoDisableAt}
              onChange={(next) => setAutoDisableAt(next)}
              variant="full"
            />
            <p className="mt-1 text-[11px] text-muted">
              Useful for contractors, interns, and audit access. The
              account is disabled automatically when the date passes.
            </p>
          </div>
        ) : null}

        <CapabilitiesSection userId={user.id} role={orgRole} />

        {error ? (
          <p className="text-xs text-danger" role="alert">
            {error}
          </p>
        ) : null}

        <div className="flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="h-9 rounded-md border border-border bg-surface-1 px-3 text-xs font-medium text-ink-1 hover:bg-surface-2 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={submitting}
            className="inline-flex h-9 items-center gap-1.5 rounded-md bg-accent px-3 text-xs font-medium text-accent-foreground hover:opacity-90 disabled:opacity-50"
          >
            {submitting ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Save className="h-3.5 w-3.5" />
            )}
            Save changes
          </button>
        </div>
      </form>
    </div>
  );
}

// ---------------------------------------------------------------
// Capabilities section
// ---------------------------------------------------------------

interface CapabilityRow {
  capability: string;
  baseline: boolean;
  effective: boolean;
  override: {
    enabled: boolean;
    note: string | null;
    grantedBy: string;
    grantedAt: string;
  } | null;
}

interface CapabilityListResponse {
  rows: CapabilityRow[];
  effective: string[];
}

/**
 * Effective capability set for a user, with per-capability overrides
 * layered on top of the role baseline. Toggling a row syncs to the
 * server immediately (POST upsert / DELETE) and then re-renders from
 * the fresh response so the override badges stay accurate.
 *
 * `role` is read from the parent dialog's draft state so the
 * baseline column updates live as the admin flips the role
 * dropdown above. The actual role change does not persist until the
 * dialog's Save button fires; while the role is in flux, baselines
 * shown here are the prospective ones.
 */
function CapabilitiesSection({
  userId,
  role,
}: {
  userId: string;
  role: OrgRole;
}) {
  const [rows, setRows] = useState<CapabilityRow[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch(
        `/api/portal/admin/users/${userId}/capabilities`,
      );
      if (!res.ok) {
        setError(`Failed to load capabilities (${res.status}).`);
        return;
      }
      const body = (await res.json()) as CapabilityListResponse;
      setRows(body.rows);
    } catch (err) {
      setError((err as Error).message ?? 'Failed to load capabilities');
    }
  }, [userId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // The API computes baseline against the user's persisted role. If
  // the admin is mid-edit and has changed the dropdown, recompute the
  // visible baseline column locally so the row matches the role they
  // are about to save. (The list endpoint will catch up after Save.)
  const localBaselines = useMemo(() => {
    if (!rows) return null;
    // Defend against an unknown role string flowing in from a stale
    // Keycloak attribute (e.g. legacy 'publisher' before #69's
    // rename). An unknown role has no baselines so we fall back to
    // an empty set, which keeps `has()` from throwing and lets the
    // server-supplied row.baseline drive the rendering instead.
    const baselines = ROLE_BASELINES_LOCAL[role] ?? new Set<string>();
    return new Map(
      rows.map((r) => [r.capability, baselines.has(r.capability)]),
    );
  }, [rows, role]);

  async function applyToggle(row: CapabilityRow) {
    setBusy(row.capability);
    setError(null);
    try {
      const baseline = localBaselines?.get(row.capability) ?? row.baseline;
      const newEffective = !row.effective;
      // If the new desired state matches the baseline, the row should
      // not have an override at all. Otherwise upsert the override.
      const url = `/api/portal/admin/users/${userId}/capabilities`;
      let res: Response;
      if (newEffective === baseline) {
        res = await fetch(`${url}/${row.capability}`, { method: 'DELETE' });
      } else {
        res = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            capability: row.capability,
            enabled: newEffective,
          }),
        });
      }
      if (!res.ok) {
        setError(`Save failed (${res.status}).`);
        return;
      }
      const body = (await res.json()) as CapabilityListResponse;
      setRows(body.rows);
    } catch (err) {
      setError((err as Error).message ?? 'Save failed');
    } finally {
      setBusy(null);
    }
  }

  async function resetToBaseline(capability: string) {
    setBusy(capability);
    setError(null);
    try {
      const res = await fetch(
        `/api/portal/admin/users/${userId}/capabilities/${capability}`,
        { method: 'DELETE' },
      );
      if (!res.ok) {
        setError(`Reset failed (${res.status}).`);
        return;
      }
      const body = (await res.json()) as CapabilityListResponse;
      setRows(body.rows);
    } catch (err) {
      setError((err as Error).message ?? 'Reset failed');
    } finally {
      setBusy(null);
    }
  }

  return (
    <fieldset className="space-y-2 rounded-md border border-border bg-surface-0 p-2">
      <legend className="px-1 text-xs uppercase tracking-wide text-muted">
        Capabilities
      </legend>
      {!rows ? (
        <p className="text-xs text-muted">Loading capabilities...</p>
      ) : (
        <ul className="space-y-1">
          {rows.map((row) => {
            const baseline =
              localBaselines?.get(row.capability) ?? row.baseline;
            const overridden = row.override !== null;
            return (
              <li
                key={row.capability}
                className="flex items-center gap-2 text-xs"
              >
                <input
                  type="checkbox"
                  checked={row.effective}
                  disabled={busy !== null}
                  onChange={() => void applyToggle(row)}
                  className="h-3.5 w-3.5 rounded border-border text-accent focus:ring-accent/30"
                  aria-label={row.capability}
                />
                <span className="flex-1 font-mono text-[11px] text-ink-1">
                  {row.capability}
                </span>
                {overridden ? (
                  <span
                    className={
                      row.effective
                        ? 'rounded bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700'
                        : 'rounded bg-rose-500/15 px-1.5 py-0.5 text-[10px] font-medium text-rose-700'
                    }
                  >
                    {row.effective ? 'override granted' : 'override revoked'}
                  </span>
                ) : (
                  <span className="rounded bg-surface-2 px-1.5 py-0.5 text-[10px] font-medium text-muted">
                    {baseline ? 'baseline' : 'not granted'}
                  </span>
                )}
                {overridden ? (
                  <button
                    type="button"
                    title="Reset to role default"
                    disabled={busy !== null}
                    onClick={() => void resetToBaseline(row.capability)}
                    className="inline-flex h-6 w-6 items-center justify-center rounded text-muted hover:bg-surface-2 hover:text-ink-1 disabled:opacity-50"
                  >
                    <RotateCcw className="h-3.5 w-3.5" />
                  </button>
                ) : (
                  <span className="h-6 w-6" aria-hidden="true" />
                )}
              </li>
            );
          })}
        </ul>
      )}
      {error ? (
        <p className="text-[11px] text-danger" role="alert">
          {error}
        </p>
      ) : null}
      <p className="text-[11px] text-muted">
        Overrides take effect immediately and are independent of the Save
        button above.
      </p>
    </fieldset>
  );
}

/**
 * Local mirror of the API's role baselines. Kept in sync with
 * apps/portal-api/src/auth/capabilities.ts. When adding a new
 * capability, update both. (The full list also lives in
 * docs/handoff/per-user-capability-overrides.md.)
 */
const ROLE_BASELINES_LOCAL: Record<OrgRole, Set<string>> = {
  viewer: new Set(['can_view_public_items']),
  contributor: new Set([
    'can_view_public_items',
    'can_publish_items',
    'can_share_items',
    'can_edit_own_items',
  ]),
  admin: new Set([
    'can_view_public_items',
    'can_publish_items',
    'can_share_items',
    'can_edit_own_items',
    'can_edit_any_item',
    'can_manage_users',
    'can_edit_branding',
    'can_manage_basemaps',
    'can_disable_users',
    'can_run_housekeeping',
  ]),
};

/**
 * Short, human-friendly "time since" label for the Last Login column.
 * Tooltip on the cell shows the full ISO timestamp.
 */
function formatRelative(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  const diff = Date.now() - t;
  const s = Math.floor(diff / 1000);
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm ago';
  const h = Math.floor(m / 60);
  if (h < 24) return h + 'h ago';
  const d = Math.floor(h / 24);
  if (d < 30) return d + 'd ago';
  const months = Math.floor(d / 30);
  if (months < 12) return months + 'mo ago';
  const years = Math.floor(d / 365);
  return years + 'y ago';
}
