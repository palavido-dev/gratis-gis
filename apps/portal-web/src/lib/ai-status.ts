// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

import { useEffect, useState } from 'react';

/**
 * Whether this organization has an AI provider connected, for the
 * places that offer AI (the Build entry and page, the item draft
 * panel). Those stay hidden until the answer is yes, so a portal with
 * no provider never shows AI controls that only say "not set up".
 *
 * One request per page load, shared by every component that asks.
 * The admin AI page calls invalidateAiStatus() after a save or clear
 * so the sidebar follows without a reload.
 */
const EVENT = 'gg:ai-status-changed';
let pending: Promise<boolean> | null = null;

export function fetchAiConfigured(): Promise<boolean> {
  if (!pending) {
    pending = fetch('/api/portal/ai/status')
      .then(async (res) => {
        if (!res.ok) return false;
        const body = (await res.json()) as { configured?: unknown };
        return body.configured === true;
      })
      .catch(() => false);
  }
  return pending;
}

export function invalidateAiStatus(): void {
  pending = null;
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(EVENT));
}

/** null while unknown, then true or false. Pass false to skip the request. */
export function useAiConfigured(enabled = true): boolean | null {
  const [configured, setConfigured] = useState<boolean | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const load = () => {
      void fetchAiConfigured().then((v) => {
        if (!cancelled) setConfigured(v);
      });
    };
    load();
    window.addEventListener(EVENT, load);
    return () => {
      cancelled = true;
      window.removeEventListener(EVENT, load);
    };
  }, [enabled]);
  return configured;
}
