// SPDX-License-Identifier: AGPL-3.0-or-later
import { apiErrorMessage, parseApiError } from './api-error';

describe('parseApiError', () => {
  it('uses the Nest message and drops the wrapper', async () => {
    const res = new Response(
      JSON.stringify({
        message: 'Could not load sign-in settings.',
        error: 'Bad Gateway',
        statusCode: 502,
      }),
      { status: 502, headers: { 'content-type': 'application/json' } },
    );
    await expect(parseApiError(res, 'Could not load sign-in settings')).resolves.toBe(
      'Could not load sign-in settings.',
    );
  });

  it('joins validation messages', async () => {
    const res = new Response(
      JSON.stringify({ message: ['Alias is too long.', 'Name is required.'] }),
      { status: 400 },
    );
    await expect(parseApiError(res)).resolves.toBe(
      'Alias is too long. Name is required.',
    );
  });

  it('keeps the status on the sentence so not-found checks still match', async () => {
    const res = new Response(
      JSON.stringify({ message: 'Item not found' }),
      { status: 404 },
    );
    await expect(apiErrorMessage(res, 'Could not load the item')).resolves.toBe(
      'Item not found (404)',
    );
  });

  it('hides an HTML error page behind the status', async () => {
    const res = new Response('<html><body>Bad Gateway</body></html>', {
      status: 502,
    });
    await expect(parseApiError(res, 'Could not load sign-in settings')).resolves.toBe(
      'Could not load sign-in settings (502).',
    );
  });
});
