import type { FormSchema } from '@gratis-gis/form-schema';
import { apiFetch } from '@/lib/api';
import { RespondClient } from './respond-client';

interface Props {
  params: { id: string };
}

interface ItemPayload {
  id: string;
  type: string;
  title: string;
  data: unknown;
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
export default async function FormRespondPage({ params }: Props) {
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
  return <RespondClient form={schema} formItemTitle={item.title} />;
}
