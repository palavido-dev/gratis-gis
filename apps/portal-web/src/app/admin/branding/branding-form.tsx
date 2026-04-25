'use client';

import { useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import {
  AlertTriangle,
  Check,
  ExternalLink,
  Loader2,
  Save,
} from 'lucide-react';
import type { BrandingConfig } from './page';
import { FeaturedItemsPicker } from './featured-items-picker';
import { ImageUploader } from '@/components/image-uploader';

/**
 * Admin form for the five Organization landing-page knobs.
 *
 * Sends a sparse PATCH so only changed fields round-trip; omitted
 * fields are left untouched server-side. Featured items are picked
 * + reordered via FeaturedItemsPicker (see #54), replacing an
 * earlier "paste UUIDs" textarea that violated the guided-before-raw
 * design rule.
 */
interface Props {
  initial: BrandingConfig;
}

export function BrandingForm({ initial }: Props) {
  const router = useRouter();
  const [title, setTitle] = useState(initial.landingTitle ?? '');
  const [subtitle, setSubtitle] = useState(initial.landingSubtitle ?? '');
  const [heroImageUrl, setHeroImageUrl] = useState<string | null>(
    initial.landingHeroImageUrl ?? null,
  );
  const [showPublicItems, setShowPublicItems] = useState(
    initial.landingShowPublicItems,
  );
  // Featured-item ordering is the authored list itself — no string
  // intermediate any more. The picker emits the full array on every
  // change so the dirty check can compare directly.
  const [featuredIds, setFeaturedIds] = useState<string[]>(
    initial.landingFeaturedItemIds,
  );

  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  // Reference-equality-ish dirty check. Comparing strings + booleans +
  // arrays covers every field. Feature ids compared as a normalized
  // space-less string so 'a, b' vs 'a,b' reads as no change.
  const dirty = useMemo(() => {
    if ((title.trim() || null) !== (initial.landingTitle ?? null)) return true;
    if ((subtitle.trim() || null) !== (initial.landingSubtitle ?? null))
      return true;
    if (heroImageUrl !== (initial.landingHeroImageUrl ?? null)) return true;
    if (showPublicItems !== initial.landingShowPublicItems) return true;
    const saved = initial.landingFeaturedItemIds;
    if (featuredIds.length !== saved.length) return true;
    for (let i = 0; i < featuredIds.length; i += 1) {
      if (featuredIds[i] !== saved[i]) return true;
    }
    return false;
  }, [
    title,
    subtitle,
    heroImageUrl,
    showPublicItems,
    featuredIds,
    initial,
  ]);

  async function save() {
    setError(null);
    setSaving(true);
    try {
      const body: Record<string, unknown> = {
        landingTitle: title.trim() || null,
        landingSubtitle: subtitle.trim() || null,
        landingHeroImageUrl: heroImageUrl,
        landingShowPublicItems: showPublicItems,
        // The picker only emits ids it resolved against the public
        // items list, so per-row UUID validation isn't needed here
        // any more — invalid pastes can't get into the state.
        landingFeaturedItemIds: featuredIds,
      };
      const res = await fetch('/api/portal/admin/branding', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        setError(`Save failed: ${res.status} ${await res.text()}`);
        return;
      }
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
      startTransition(() => router.refresh());
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-5">
      <section className="space-y-4 rounded-lg border border-border bg-surface-1 p-5">
        <div>
          <label
            htmlFor="landing-title"
            className="mb-1 block text-xs font-medium uppercase tracking-wide text-muted"
          >
            Title
          </label>
          <input
            id="landing-title"
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder={initial.name}
            maxLength={200}
            className="h-10 w-full rounded-md border border-border bg-surface-1 px-3 text-sm focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30"
          />
          <p className="mt-1 text-[11px] text-muted">
            Shown as the hero heading. Leave blank to fall back to the
            organization name (&ldquo;{initial.name}&rdquo;).
          </p>
        </div>

        <div>
          <label
            htmlFor="landing-subtitle"
            className="mb-1 block text-xs font-medium uppercase tracking-wide text-muted"
          >
            Subtitle
          </label>
          <input
            id="landing-subtitle"
            type="text"
            value={subtitle}
            onChange={(e) => setSubtitle(e.target.value)}
            placeholder="Public geospatial content for our community"
            maxLength={500}
            className="h-10 w-full rounded-md border border-border bg-surface-1 px-3 text-sm focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30"
          />
          <p className="mt-1 text-[11px] text-muted">
            One-line tagline under the title. Optional.
          </p>
        </div>

        <div>
          <p className="mb-1 block text-xs font-medium uppercase tracking-wide text-muted">
            Hero image
          </p>
          <ImageUploader
            kind="org-hero"
            value={heroImageUrl}
            onChange={setHeroImageUrl}
            seed={initial.id}
            label="Landing page hero"
            size="xl"
            rounded="md"
            hint="Wide images work best (think 1920x640 or larger, jpg/png/webp/gif). Up to 5 MB. Leave empty for a muted fill."
          />
        </div>
      </section>

      <section className="space-y-4 rounded-lg border border-border bg-surface-1 p-5">
        <label className="flex items-start gap-3 text-sm">
          <input
            type="checkbox"
            checked={showPublicItems}
            onChange={(e) => setShowPublicItems(e.target.checked)}
            className="mt-0.5 h-4 w-4 rounded border-border text-accent focus:ring-accent/30"
          />
          <span>
            <span className="font-medium text-ink-0">
              Show public items on the landing page
            </span>
            <span className="mt-0.5 block text-[11px] text-muted">
              When off, the landing page shows only the title, optional
              hero, and a Sign-in button. Pick this for a clean logo-only
              page if you don&apos;t want the public browse grid.
            </span>
          </span>
        </label>

        <div>
          <p className="mb-1 text-xs font-medium uppercase tracking-wide text-muted">
            Featured items
          </p>
          <p className="mb-2 text-[11px] text-muted">
            Pick the public items you want pinned to the top of the
            landing page, in the order they should appear. Leave the
            list empty to show every public item in the org, newest
            first.
          </p>
          <FeaturedItemsPicker
            value={featuredIds}
            onChange={setFeaturedIds}
          />
        </div>
      </section>

      {error ? (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-md border border-danger/30 bg-danger/5 px-3 py-2 text-sm text-danger"
        >
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{error}</span>
        </div>
      ) : null}

      <div className="flex items-center justify-between">
        <a
          href="/"
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 text-xs text-muted hover:text-ink-1"
        >
          <ExternalLink className="h-3 w-3" />
          Open landing page in a new tab
        </a>
        <div className="flex items-center gap-2">
          {saved ? (
            <span className="inline-flex items-center gap-1 text-xs text-success">
              <Check className="h-3.5 w-3.5" /> Saved
            </span>
          ) : null}
          <button
            type="button"
            onClick={save}
            disabled={saving || !dirty}
            className="inline-flex h-10 items-center gap-1.5 rounded-md bg-accent px-4 text-sm font-medium text-accent-foreground shadow-card hover:opacity-90 disabled:opacity-50"
          >
            {saving ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Save className="h-4 w-4" />
            )}
            Save
          </button>
        </div>
      </div>
    </div>
  );
}

