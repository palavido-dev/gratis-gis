// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { ImageUploader } from '@/components/image-uploader';
import { useT } from '@/lib/i18n/locale-context';

interface Props {
  userId: string;
  fullName: string;
  initialAvatarUrl: string | null;
}

/**
 * Client-side avatar editor. Uploads the file via presign, then PATCHes
 * /api/portal/users/me so the badge updates everywhere else the next
 * time pages render. Router.refresh() kicks the server components
 * (notably the top bar in the shell) to re-fetch and paint the new one.
 */
export function AvatarEditor({ userId, fullName, initialAvatarUrl }: Props) {
  const t = useT();
  const router = useRouter();
  const [avatarUrl, setAvatarUrl] = useState<string | null>(initialAvatarUrl);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleChange(next: string | null) {
    setError(null);
    setAvatarUrl(next);
    setSaving(true);
    try {
      const res = await fetch('/api/portal/users/me', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ avatarUrl: next }),
      });
      if (!res.ok) {
        setError(
          t('profile.avatar.saveFailed', {
            status: String(res.status),
            detail: await res.text(),
          }),
        );
        // Revert optimistic local state so the badge reflects reality.
        setAvatarUrl(initialAvatarUrl);
        return;
      }
      router.refresh();
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-3">
      <ImageUploader
        kind="user-avatar"
        value={avatarUrl}
        onChange={handleChange}
        seed={userId}
        label={fullName}
        size="xl"
        rounded="full"
      />
      {saving ? (
        <p className="text-xs text-muted">{t('profile.avatar.saving')}</p>
      ) : null}
      {error ? (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}
