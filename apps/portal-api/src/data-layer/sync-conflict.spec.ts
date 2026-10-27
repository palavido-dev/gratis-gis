// SPDX-License-Identifier: AGPL-3.0-or-later
import { FeatureConflictException } from './features.service.js';

describe('FeatureConflictException', () => {
  it('includes losingSide and conflictArtifactId when provided', () => {
    const current = {
      type: 'Feature' as const,
      id: 'f1',
      geometry: null,
      properties: { _observation_id: 'head' },
    };
    const losing = {
      type: 'Feature' as const,
      id: 'f1',
      geometry: null,
      properties: { name: 'mine' },
    };
    const err = new FeatureConflictException(current, {
      losingSide: losing,
      conflictArtifactId: 'art-1',
    });
    const body = err.getResponse() as Record<string, unknown>;
    expect(body.code).toBe('feature-conflict');
    expect(body.current).toEqual(current);
    expect(body.losingSide).toEqual(losing);
    expect(body.conflictArtifactId).toBe('art-1');
  });

  it('omits optional extras when absent', () => {
    const err = new FeatureConflictException(null);
    const body = err.getResponse() as Record<string, unknown>;
    expect(body.current).toBeNull();
    expect(body).not.toHaveProperty('losingSide');
    expect(body).not.toHaveProperty('conflictArtifactId');
  });
});
