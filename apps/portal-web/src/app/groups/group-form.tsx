// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import {
  Building2,
  Check,
  Globe2,
  Loader2,
  Lock,
  Save,
  Sparkles,
} from 'lucide-react';
import type { Group, GroupAccess } from '@gratis-gis/shared-types';
import { ImageUploader } from '@/components/image-uploader';

type Mode =
  | { kind: 'create' }
  | { kind: 'edit'; groupId: string };

interface Props {
  mode: Mode;
  initialValues?: Partial<
    Pick<Group, 'title' | 'description' | 'access' | 'thumbnailUrl'>
  >;
}

const accessOptions: Array<{
  value: GroupAccess;
  label: string;
  desc: string;
  Icon: typeof Lock;
}> = [
  {
    value: 'private',
    label: 'Private',
    desc: 'Invitation only. The group is hidden outside its members.',
    Icon: Lock,
  },
  {
    value: 'org',
    label: 'Your organization',
    desc: 'Anyone in your org can find and request to join.',
    Icon: Building2,
  },
  {
    value: 'public',
    label: 'Public',
    desc: 'Discoverable by anyone on the internet.',
    Icon: Globe2,
  },
];

/**
 * Create/edit form for a group's identity and visibility. Membership is
 * managed on the group detail page; this form intentionally stays out
 * of that to keep the two concerns distinct. Mirrors the ItemForm
 * component so both surfaces feel part of the same system.
 */
export function GroupForm({ mode, initialValues }: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [submitting, setSubmitting] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [title, setTitle] = useState(initialValues?.title ?? '');
  const [description, setDescription] = useState(
    initialValues?.description ?? '',
  );
  const [access, setAccess] = useState<GroupAccess>(
    (initialValues?.access as GroupAccess) ?? 'private',
  );
  const [thumbnailUrl, setThumbnailUrl] = useState<string | null>(
    initialValues?.thumbnailUrl ?? null,
  );

  async function submit() {
    setError(null);
    if (title.trim().length === 0) {
      setError('Title is required.');
      return;
    }
    setSubmitting(true);

    const payload: Record<string, unknown> = {
      title: title.trim(),
      description: description.trim(),
      access,
      thumbnailUrl,
    };

    const url =
      mode.kind === 'create'
        ? '/api/portal/groups'
        : `/api/portal/groups/${mode.groupId}`;
    const method = mode.kind === 'create' ? 'POST' : 'PATCH';

    const res = await fetch(url, {
      method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    setSubmitting(false);
    if (!res.ok) {
      setError(`${method} failed: ${res.status} ${await res.text()}`);
      return;
    }
    const savedGroup = (await res.json()) as Group;
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);

    if (mode.kind === 'create') {
      // Land on the new group's detail page so the owner can add members.
      startTransition(() => router.push(`/groups/${savedGroup.id}`));
    } else {
      startTransition(() => router.refresh());
    }
  }

  return (
    <div className="space-y-8">
      <section>
        <label className="mb-2 block text-xs font-medium uppercase tracking-wide text-muted">
          Thumbnail
        </label>
        <ImageUploader
          kind="group-thumb"
          value={thumbnailUrl}
          onChange={setThumbnailUrl}
          seed={mode.kind === 'edit' ? mode.groupId : title || 'new-group'}
          label={title || 'New group'}
          size="xl"
          rounded="md"
        />
      </section>

      <section className="space-y-4">
        <div>
          <label
            htmlFor="title"
            className="mb-1 block text-xs font-medium uppercase tracking-wide text-muted"
          >
            Name
          </label>
          <input
            id="title"
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Field team, Planning review, Partner org..."
            maxLength={120}
            className="h-10 w-full rounded-md border border-border bg-surface-1 px-3 text-sm focus:border-accent focus:outline-hidden focus:ring-2 focus:ring-accent/30"
          />
        </div>

        <div>
          <label
            htmlFor="description"
            className="mb-1 block text-xs font-medium uppercase tracking-wide text-muted"
          >
            Description
          </label>
          <textarea
            id="description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Who's in this group and what do they share?"
            maxLength={2000}
            rows={4}
            className="w-full rounded-md border border-border bg-surface-1 px-3 py-2 text-sm focus:border-accent focus:outline-hidden focus:ring-2 focus:ring-accent/30"
          />
        </div>
      </section>

      <section>
        <label className="mb-2 block text-xs font-medium uppercase tracking-wide text-muted">
          Visibility
        </label>
        <div className="grid grid-cols-3 gap-2" role="radiogroup">
          {accessOptions.map(({ value, label, desc, Icon }) => {
            const selected = access === value;
            return (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={selected}
                onClick={() => setAccess(value)}
                className={`flex flex-col items-start gap-1 rounded-md border p-3 text-left transition-colors ${
                  selected
                    ? 'border-accent bg-accent/5 ring-2 ring-accent/30'
                    : 'border-border bg-surface-1 hover:bg-surface-2'
                }`}
              >
                <div className="flex items-center gap-2">
                  <Icon
                    className={`h-4 w-4 ${selected ? 'text-accent' : 'text-muted'}`}
                  />
                  <span className="text-sm font-medium text-ink-1">{label}</span>
                </div>
                <span className="text-xs text-muted">{desc}</span>
              </button>
            );
          })}
        </div>
        <p className="mt-2 text-xs text-muted">
          Visibility controls discoverability. Whether someone can
          actually join the group still requires an admin to invite them.
        </p>
      </section>

      {error ? (
        <div
          className="rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger"
          role="alert"
        >
          {error}
        </div>
      ) : null}

      <div className="flex items-center justify-end gap-3">
        {saved ? (
          <span className="inline-flex items-center gap-1 text-sm text-success">
            <Check className="h-4 w-4" />
            Saved
          </span>
        ) : null}
        <button
          type="button"
          onClick={() => router.back()}
          disabled={submitting || pending}
          className="h-10 rounded-md border border-border bg-surface-1 px-4 text-sm text-ink-1 hover:bg-surface-2 disabled:opacity-50"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={submit}
          disabled={submitting || pending}
          className="inline-flex h-10 items-center gap-2 rounded-md bg-accent px-4 text-sm font-medium text-accent-foreground shadow-card hover:opacity-90 disabled:opacity-50"
        >
          {submitting ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : mode.kind === 'create' ? (
            <Sparkles className="h-4 w-4" />
          ) : (
            <Save className="h-4 w-4" />
          )}
          {mode.kind === 'create' ? 'Create group' : 'Save changes'}
        </button>
      </div>
    </div>
  );
}
