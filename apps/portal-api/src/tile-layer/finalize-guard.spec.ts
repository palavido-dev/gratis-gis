// SPDX-License-Identifier: AGPL-3.0-or-later
import { ConflictException } from '@nestjs/common';

import { TileLayerService } from './tile-layer.service.js';

/**
 * A retry of a slow finalize used to start a second conversion of the
 * same item beside the first. One finalize per item at a time.
 */
describe('TileLayerService.finalizeUpload guard', () => {
  it('refuses a second finalize of the same item while one runs', async () => {
    const svc = new TileLayerService({} as never, {} as never, {} as never, {} as never, {} as never);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const once = jest
      .spyOn(svc as unknown as { finalizeUploadOnce: () => Promise<unknown> }, 'finalizeUploadOnce')
      .mockImplementation(async () => {
        await gate;
        return {};
      });
    const input = { storageKey: 'k', storageUrl: 'u', fileName: 'a.tif', sizeBytes: 1 };
    const first = svc.finalizeUpload({} as never, 'item-1', input);
    await expect(svc.finalizeUpload({} as never, 'item-1', input)).rejects.toBeInstanceOf(
      ConflictException,
    );
    // Another item is not blocked.
    const other = svc.finalizeUpload({} as never, 'item-2', input);
    release();
    await Promise.all([first, other]);
    expect(once).toHaveBeenCalledTimes(2);
    // Free again once the first finished.
    await expect(svc.finalizeUpload({} as never, 'item-1', input)).resolves.toEqual({});
  });
});
