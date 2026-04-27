import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft, Users, Lock, Building2, Globe2, Pencil } from 'lucide-react';
import type { Group, GroupMember, User } from '@gratis-gis/shared-types';
import { EntityBadge } from '@gratis-gis/ui';
import { apiFetch } from '@/lib/api';
import { MembersPanel } from './members-panel';
import { DeleteGroupButton } from './delete-button';

interface Props {
  params: { id: string };
}

const accessIcon = {
  private: <Lock className="h-3.5 w-3.5" />,
  org: <Building2 className="h-3.5 w-3.5" />,
  public: <Globe2 className="h-3.5 w-3.5" />,
};

type MemberWithUser = GroupMember & { user: Pick<User, 'id' | 'username' | 'fullName'> };

export default async function GroupDetailPage({ params }: Props) {
  let group: Group;
  let members: MemberWithUser[];
  try {
    [group, members] = await Promise.all([
      apiFetch<Group>(`/api/groups/${params.id}`),
      apiFetch<MemberWithUser[]>(`/api/groups/${params.id}/members`),
    ]);
  } catch (err) {
    if (err instanceof Error && err.message.includes('404')) notFound();
    throw err;
  }

  const me = await apiFetch<{ id: string; orgRole: string }>('/api/users/me');
  const canManage = me.id === group.ownerId || me.orgRole === 'admin';
  // Owner-not-member badge (#102): an owner can remove their own
  // membership while keeping the group; the badge reminds them of
  // that state so 5 months later it's not a mystery why their
  // access feels different. Only computed for the actual owner --
  // an org admin who isn't the owner just sees the regular owner
  // line.
  const isOwner = group.ownerId === me.id;
  const isMember = members.some((m) => m.userId === me.id);
  const ownerNotMember = isOwner && !isMember;

  return (
    <div className="mx-auto w-full max-w-5xl px-6 py-10">
      <Link
        href="/groups"
        className="mb-6 inline-flex items-center gap-1 text-sm text-muted hover:text-ink-0"
      >
        <ArrowLeft className="h-4 w-4" />
        Back to groups
      </Link>

      <header className="mb-8 flex items-start justify-between gap-4">
        <div className="flex min-w-0 flex-1 items-start gap-4">
          <EntityBadge
            label={group.title}
            seed={group.id}
            imageUrl={group.thumbnailUrl}
            size="xl"
            rounded="md"
          />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="inline-flex items-center gap-1 rounded-full border border-border bg-surface-2 px-2 py-0.5 text-xs text-muted">
                {accessIcon[group.access]}
                {group.access}
              </span>
            </div>
            <h1 className="mt-2 text-3xl font-semibold tracking-tight">
              {group.title}
            </h1>
            {group.description ? (
              <p className="mt-2 max-w-3xl text-sm text-muted">
                {group.description}
              </p>
            ) : null}
            <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-muted">
              <span>
                Owner:{' '}
                {group.ownerId === me.id ? 'you' : group.ownerId.slice(0, 8)}
              </span>
              {/* Persistent reminder when the owner has removed
                  their own membership (#102). Hovering the chip
                  spells out exactly what's different about this
                  state, so 5 months from now they don't wonder why
                  the group looks weird. */}
              {ownerNotMember ? (
                <span
                  title={
                    'You own this group but aren’t a member of it.\n' +
                    'You can still:\n' +
                    '  - Manage the group (rename, edit access, add/remove members)\n' +
                    '  - Share items TO the group\n' +
                    '\n' +
                    'You won’t see:\n' +
                    '  - Items shared to the group through your personal access\n' +
                    '    (that’s a member-only path; add yourself back to see them)'
                  }
                  className="inline-flex items-center gap-1 rounded-full border border-amber-300 bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-900"
                >
                  Owner, not a member
                </span>
              ) : null}
            </div>
          </div>
        </div>
        {canManage ? (
          <div className="flex shrink-0 items-center gap-2">
            <Link
              href={`/groups/${group.id}/edit`}
              className="inline-flex h-9 items-center gap-1.5 rounded-md border border-border bg-surface-1 px-3 text-sm font-medium text-ink-1 shadow-card hover:bg-surface-2"
            >
              <Pencil className="h-4 w-4" />
              Edit
            </Link>
            <DeleteGroupButton groupId={group.id} groupTitle={group.title} />
          </div>
        ) : null}
      </header>

      <section className="mb-8">
        <h2 className="mb-4 flex items-center gap-2 text-sm font-medium text-muted">
          <Users className="h-4 w-4" />
          Members
        </h2>
        <MembersPanel
          groupId={group.id}
          initialMembers={members}
          canManage={canManage}
          currentUserId={me.id}
          isOwner={isOwner}
        />
      </section>
    </div>
  );
}
