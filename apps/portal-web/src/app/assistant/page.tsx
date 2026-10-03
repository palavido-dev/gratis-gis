// SPDX-License-Identifier: AGPL-3.0-or-later
import { BuildComposer } from './build-composer';

export const metadata = {
  title: 'Build',
};

/**
 * Natural-language builder. The signed-in shell already wraps
 * this route; the composer talks to the portal API.
 */
export default function BuildPage() {
  return (
    <div className="mx-auto w-full max-w-3xl px-6 py-10">
      <h1 className="text-xl font-semibold text-ink-0">Build from a description</h1>
      <p className="mt-2 text-sm text-ink-1">
        Describe a layer, a map, a form, or an app. GratisGIS reuses a
        layer you already have when it fits, and creates what is
        missing. Speak the description or type it. Nothing is created
        until you choose Build it.
      </p>
      <div className="mt-8">
        <BuildComposer />
      </div>
    </div>
  );
}
