// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

import { createContext, useContext, useState } from 'react';
import type { DataLayerDataV3 } from '@gratis-gis/shared-types';

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
 * `initial` is the server-rendered blob. Dirtiness is reference
 * inequality against it, matching the pre-split editor: the builder
 * replaces the whole value on every edit, so `data !== initial`
 * tracks any user mutation.
 */

interface V3EditorState {
  data: DataLayerDataV3;
  setData: (next: DataLayerDataV3) => void;
  initial: DataLayerDataV3;
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
  const [data, setData] = useState<DataLayerDataV3>(initial);
  return (
    <V3EditorContext.Provider value={{ data, setData, initial }}>
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
