// SPDX-License-Identifier: AGPL-3.0-or-later
import { probeSelection } from './arcgis-service-selection';

const layers = (ids: number[]) => ids.map((id) => ({ id, name: `L${id}` }));

describe('probeSelection', () => {
  it('selects everything when there was no previous choice', () => {
    expect(probeSelection({ layers: layers([0, 1]) }, [0, 1, 2])).toEqual([0, 1, 2]);
  });

  it('keeps the previous choice and adds newly found layers', () => {
    expect(
      probeSelection({ layers: layers([0, 1]), selectedLayerIds: [1] }, [0, 1, 2]),
    ).toEqual([1, 2]);
  });

  it('falls back to all when nothing would be left', () => {
    expect(
      probeSelection({ layers: layers([0, 1]), selectedLayerIds: [] }, [0, 1]),
    ).toEqual([0, 1]);
  });
});
