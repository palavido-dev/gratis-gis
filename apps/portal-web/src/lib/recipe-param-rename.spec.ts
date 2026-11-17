// SPDX-License-Identifier: AGPL-3.0-or-later
import type { RecipeAction } from '@gratis-gis/shared-types';
import { renameRecipeParameter } from './recipe-param-rename';

const recipe = {
  kind: 'recipe',
  parameters: [],
  pipeline: [
    {
      tool: 'spatial-filter',
      params: {
        otherSource: { kind: 'parameter', name: 'layer' },
        predicate: { kind: 'fixed', value: 'intersects' },
      },
    },
  ],
  output: { kind: 'selection', targetParameterRef: 'layer' },
  sourceParameterRef: 'layer',
  aoiParameterRef: 'aoi',
} as unknown as RecipeAction;

describe('renameRecipeParameter', () => {
  it('moves every reference to the new name', () => {
    const out = renameRecipeParameter(recipe, 'layer', 'layers') as unknown as {
      pipeline: Array<{ params: { otherSource: { name: string } } }>;
      output: { targetParameterRef: string };
      sourceParameterRef: string;
      aoiParameterRef: string;
    };
    expect(out.pipeline[0]!.params.otherSource.name).toBe('layers');
    expect(out.output.targetParameterRef).toBe('layers');
    expect(out.sourceParameterRef).toBe('layers');
    expect(out.aoiParameterRef).toBe('aoi');
  });

  it('clears the optional refs when the parameter is removed', () => {
    const out = renameRecipeParameter(recipe, 'aoi', '');
    expect('aoiParameterRef' in out).toBe(false);
    expect(out.sourceParameterRef).toBe('layer');
  });
});
