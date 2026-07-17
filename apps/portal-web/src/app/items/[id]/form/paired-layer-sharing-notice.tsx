// SPDX-License-Identifier: AGPL-3.0-or-later
import Link from 'next/link';
import { Database, ExternalLink, Globe2, Lock, Users2 } from 'lucide-react';
import type { Item, ItemAccess, ItemShare } from '@gratis-gis/shared-types';
import { apiFetch } from '@/lib/api';

interface Props {
  /** Form item id (used only for analytics-style copy; the actual
   *  rendering is driven by the paired data_layer fetched below). */
  formId: string;
  /** Paired data_layer id read off the form's `linkedLayerId`. When
   *  the form is brand new and hasn't materialized its paired layer
   *  yet this is `null`, and the notice renders an empty-state
   *  panel explaining why the responses-side ACL isn't editable
   *  yet. */
  linkedLayerId: string | null;
}

/**
 * #91: dual-ACL surface for forms.  The form item's ACL gates who
 * can OPEN the form (and submit a response); the paired
 * data_layer's ACL gates who can VIEW submitted responses.  Authors
 * routinely conflate the two -- they share the form publicly to
 * collect responses, then assume only they can see them, which is
 * usually right (data_layer access defaults to private) but isn't
 * something a careful author should have to take on faith.
 *
 * Rather than build a synchronized dual editor (which would tie
 * the form item's policy and the layer item's policy together in
 * a way that's hard to predict when the layer is also referenced
 * from other items), we just render a clear summary of the paired
 * layer's current access tier + share count + deep-link to its
 * own Sharing panel.  This matches the AGO pattern of "Hosted
 * feature layer (views)" living as its own item with its own
 * sharing, while gently reminding the author the link exists.
 *
 * Server component: fetches the paired layer item to render its
 * access tier.  Failure is non-fatal (the notice renders a
 * "couldn't read paired layer" hint and a deep-link the author
 * can follow to confirm by hand).
 */
export async function PairedLayerSharingNotice({ formId: _formId, linkedLayerId }: Props) {
  void _formId;
  if (!linkedLayerId) {
    return (
      <div className="mb-4 rounded-md border border-dashed border-warn/40 bg-warn/10 px-3 py-2 text-xs text-warn">
        <div className="font-medium">Responses are stored in a paired data layer</div>
        <p className="mt-1 text-warn">
          This form hasn&apos;t saved its paired data layer yet. Save the
          form with at least one question to materialize it; once it
          exists, control who can view submissions by managing the
          paired layer&apos;s sharing.
        </p>
      </div>
    );
  }

  let layer: Item | null = null;
  try {
    layer = await apiFetch<Item>(`/api/items/${linkedLayerId}`);
  } catch {
    return (
      <div className="mb-4 rounded-md border border-dashed border-border bg-surface-2/40 px-3 py-2 text-xs text-muted">
        <div className="inline-flex items-center gap-1.5 font-medium text-ink-1">
          <Database className="h-3.5 w-3.5" />
          Responses are stored in a paired data layer
        </div>
        <p className="mt-1">
          The paired layer is unreadable from here (it may be owned by
          another user). Open it directly to manage who can view
          responses:&nbsp;
          <Link
            href={`/items/${linkedLayerId}`}
            className="inline-flex items-center gap-1 text-accent hover:underline"
          >
            Paired data layer
            <ExternalLink className="h-3 w-3" />
          </Link>
        </p>
      </div>
    );
  }

  const access = (layer.access ?? 'private') as ItemAccess;
  const shareCount = Array.isArray(
    (layer as { shares?: ItemShare[] }).shares,
  )
    ? ((layer as { shares?: ItemShare[] }).shares as ItemShare[]).length
    : 0;
  const tier = describeAccess(access);

  return (
    <div className="mb-4 rounded-md border border-border bg-surface-2/40 px-3 py-2.5 text-xs">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="inline-flex items-center gap-1.5 text-2xs font-semibold uppercase tracking-wide text-muted">
            <Database className="h-3.5 w-3.5" />
            Responses are stored in a paired data layer
          </div>
          <div className="mt-1 truncate text-sm font-medium text-ink-0">
            {layer.title}
          </div>
          <div className="mt-1 inline-flex items-center gap-1.5 text-2xs">
            {tier.Icon}
            <span className="text-ink-1">{tier.label}</span>
            {shareCount > 0 ? (
              <span className="text-muted">
                +{' '}{shareCount} additional share{shareCount === 1 ? '' : 's'}
              </span>
            ) : null}
          </div>
          <p className="mt-2 max-w-2xl text-2xs text-muted">
            The settings above control who can <strong>open</strong> the
            form and submit a response. The paired layer&apos;s settings
            (linked at right) control who can <strong>view</strong>{' '}
            submitted responses. By default the layer is private, so
            only you can see what people submit.
          </p>
        </div>
        <Link
          href={`/items/${linkedLayerId}#sharing`}
          className="inline-flex shrink-0 items-center gap-1 rounded-md border border-border bg-surface-1 px-2 py-1 text-2xs font-medium text-ink-1 hover:bg-surface-2"
        >
          Manage responses access
          <ExternalLink className="h-3 w-3" />
        </Link>
      </div>
    </div>
  );
}

interface AccessSummary {
  label: string;
  Icon: JSX.Element;
}

function describeAccess(access: ItemAccess): AccessSummary {
  switch (access) {
    case 'public':
      return {
        label: 'Public (anyone with the link)',
        Icon: <Globe2 className="h-3.5 w-3.5 text-success" />,
      };
    case 'org':
      return {
        label: 'Everyone in your organization',
        Icon: <Users2 className="h-3.5 w-3.5 text-info" />,
      };
    case 'private':
    default:
      return {
        label: 'Private (owner + explicit shares)',
        Icon: <Lock className="h-3.5 w-3.5 text-muted" />,
      };
  }
}
