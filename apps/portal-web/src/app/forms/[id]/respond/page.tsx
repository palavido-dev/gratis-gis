// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Metadata } from 'next';
import type { FormSchema } from '@gratis-gis/form-schema';
import { apiFetch } from '@/lib/api';
import { RespondClient } from './respond-client';

interface Props {
  params: Promise<{ id: string }>;
}

interface ItemPayload {
  id: string;
  type: string;
  title: string;
  data: unknown;
}

/**
 * Per-form metadata so the new-tab title (and OS tab strip) shows
 * the form title rather than just "GratisGIS". Falls back to the
 * default if the lookup fails (e.g. soft-deleted form, expired
 * share). The respond runtime is intentionally chromeless (#345),
 * so the browser tab itself becomes the only place to see the
 * form's identity.
 */
export async function generateMetadata(props: Props): Promise<Metadata> {
  const params = await props.params;
  try {
    const item = await apiFetch<ItemPayload>(`/api/items/${params.id}`);
    return { title: item.title };
  } catch {
    return {};
  }
}

/**
 * Public-ish respond page for a form item (#131). Server-renders the
 * form schema once for fast first paint, hands off to the client for
 * the actual capture. The client handles offline queueing -- so once
 * the user has loaded this page once, they can keep submitting from
 * the field without connectivity.
 *
 * Auth: today the page sits behind the same JWT-cookie middleware as
 * the rest of the portal, so respondents need a portal account. A
 * follow-up adds a public-link mode (anonymous tokens, share-by-
 * URL) for surveys you genuinely want to expose to the world.
 */
export default async function FormRespondPage(props: Props) {
  const params = await props.params;
  const item = await apiFetch<ItemPayload>(`/api/items/${params.id}`);
  if (item.type !== 'form') {
    return (
      <div className="mx-auto max-w-xl px-4 py-12 text-center text-sm text-muted">
        That item is not a form.
      </div>
    );
  }
  const schema =
    item.data &&
    typeof item.data === 'object' &&
    'questions' in (item.data as object)
      ? ((item.data as unknown) as FormSchema)
      : null;
  if (!schema || schema.questions.length === 0) {
    return (
      <div className="mx-auto max-w-xl px-4 py-12 text-center text-sm text-muted">
        This form has no questions yet.
      </div>
    );
  }
  // The account submitting, so an offline response is stamped with it
  // even before the device identity guard has caught up.
  const me = await apiFetch<{ id: string }>('/api/users/me').catch(() => null);
  return (
    <RespondClient form={schema} formItemTitle={item.title} userId={me?.id ?? null} />
  );
}
