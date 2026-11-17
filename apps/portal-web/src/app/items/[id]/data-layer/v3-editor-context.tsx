// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import type { DataLayerDataV3 } from '@gratis-gis/shared-types';
import { withServerOwnedFields } from '@/lib/v3-draft-sync';

/**
 * Shared editing state for a v3 data_layer's detail page (#73).
 *
 * The v3 editor used to be one component: import panel, event-layer
 * wizard, schema builder and save button in a single column on the
 * Data tab. Splitting Data (work with the rows) and Structure (edit
 * the schema) into separate tabs means two components need the same
 * draft: the import panel's layer picker must show a layer the
 * author just added in the builder, before it is saved, exactly as
 * it did when they were one column.
 *
 * The provider therefore sits ABOVE ItemTabs (both tab panels are
 * its descendants) and owns the draft. Tab panels are hidden rather
 * than unmounted, so the draft also survives tab switches for free.
 *
 * `initial` is the server-rendered blob. Every router.refresh()
 * (after an import, a row edit, a schema save) hands in a new one.
 * The draft follows it while the user has no unsaved edits. With
 * unsaved edits it keeps them and only takes the server-owned layer
 * fields (counts, extent, provenance, conflicts), so the Data tab
 * shows current numbers and a later save does not write old ones
 * back. `dirty` is set by setData and cleared by markSaved, not
 * worked out from reference inequality, which a refresh broke.
 */

interface V3EditorState {
  data: DataLayerDataV3;
  setData: (next: DataLayerDataV3) => void;
  initial: DataLayerDataV3;
  /** The user has edits that are not saved yet. */
  dirty: boolean;
  /** Call after a successful save; the next refresh replaces the draft. */
  markSaved: () => void;
}

const V3EditorContext = createContext<V3EditorState | null>(null);

export function useV3Editor(): V3EditorState {
  const ctx = useContext(V3EditorContext);
  if (!ctx) {
    throw new Error(
      'useV3Editor must be used inside V3EditorScope with a v3 item',
    );
  }
  return ctx;
}

function V3EditorProvider({
  initial,
  children,
}: {
  initial: DataLayerDataV3;
  children: React.ReactNode;
}) {
  const [data, setDraft] = useState<DataLayerDataV3>(initial);
  const [dirty, setDirty] = useState(false);
  const setData = useCallback((next: DataLayerDataV3) => {
    setDraft(next);
    setDirty(true);
  }, []);
  const markSaved = useCallback(() => setDirty(false), []);
  useEffect(() => {
    if (!dirty) {
      setDraft(initial);
    } else {
      setDraft((prev) => withServerOwnedFields(prev, initial));
    }
    // Runs for a new server copy only. A change of `dirty` alone must
    // not pull the server copy over the draft: markSaved runs before
    // the refresh that brings the saved version back.
  }, [initial]);
  return (
    <V3EditorContext.Provider
      value={{ data, setData, initial, dirty, markSaved }}
    >
      {children}
    </V3EditorContext.Provider>
  );
}

/**
 * Wrapper the detail page can apply unconditionally: provides the
 * editor state when the item is a v3 data_layer, passes children
 * through untouched for every other item type. Keeps page.tsx free
 * of a conditional JSX wrapper around its 500-line tab body.
 */
export function V3EditorScope({
  initial,
  children,
}: {
  initial: DataLayerDataV3 | null;
  children: React.ReactNode;
}) {
  if (!initial) return <>{children}</>;
  return <V3EditorProvider initial={initial}>{children}</V3EditorProvider>;
}
