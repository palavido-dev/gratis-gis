// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  apiErrorMessage,
  parseApiError,
  presentApiFailure,
  presentClientFailure,
  readApiFailure,
  sanitizePublicDetail,
} from './api-error';

function statusLine(status: number, code: string | null): string {
  return code ? `HTTP ${status} (${code})` : `HTTP ${status}`;
}

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

describe('readApiFailure', () => {
  it('keeps the server sentence, the code, and the request id', async () => {
    const res = new Response(
      JSON.stringify({
        message: 'Creating items requires the contributor or admin role.',
        statusCode: 403,
        code: 'session-expired',
        requestId: 'abc12345abcd',
      }),
      {
        status: 403,
        headers: { 'x-request-id': 'abc12345abcd' },
      },
    );
    const failure = await readApiFailure(res);
    expect(
      presentApiFailure('The layer could not be created.', failure, statusLine),
    ).toEqual({
      summary: 'The layer could not be created.',
      detail: 'Creating items requires the contributor or admin role.',
      requestId: 'abc12345abcd',
    });
  });

  it('shows the status when the body is only the generic sentence', async () => {
    const res = new Response(
      JSON.stringify({
        message: 'Internal server error',
        statusCode: 500,
        requestId: 'abc12345abcd',
      }),
      { status: 500 },
    );
    const failure = await readApiFailure(res);
    expect(presentApiFailure('Could not create.', failure, statusLine)).toEqual({
      summary: 'Could not create.',
      detail: 'HTTP 500',
      requestId: 'abc12345abcd',
    });
  });

  it('shows an admin one-line detail under a generic message', async () => {
    const res = new Response(
      JSON.stringify({
        message: 'Internal server error',
        detail: 'relation "item" does not exist',
        requestId: 'abc12345abcd',
      }),
      { status: 500 },
    );
    const failure = await readApiFailure(res);
    expect(failure.detail).toBe('relation "item" does not exist');
    expect(
      presentApiFailure('Could not create.', failure, statusLine).detail,
    ).toBe('relation "item" does not exist');
  });

  it('hides a stack and a password even when the server sent them', async () => {
    const res = new Response(
      JSON.stringify({
        message:
          'password=hunter2\n    at ItemService.create (items.service.ts:10:5)',
        requestId: '../not a safe id',
      }),
      { status: 500, headers: { 'x-request-id': 'bad id' } },
    );
    const failure = await readApiFailure(res);
    expect(failure.detail).toBeNull();
    expect(failure.requestId).toBeNull();
    expect(presentApiFailure('Could not create.', failure, statusLine).detail).toBe(
      'HTTP 500',
    );
  });

  it('hides an HTML error page behind the status', async () => {
    const res = new Response('<html><body>Bad Gateway</body></html>', {
      status: 502,
      headers: { 'x-request-id': 'abc12345abcd' },
    });
    const shown = presentApiFailure(
      'Could not create.',
      await readApiFailure(res),
      statusLine,
    );
    expect(shown.detail).toBe('HTTP 502');
    expect(shown.requestId).toBe('abc12345abcd');
    expect(shown.detail).not.toContain('html');
  });

  it('joins validation messages and appends a machine code only as a fallback', async () => {
    const res = new Response(
      JSON.stringify({
        message: ['Alias is too long.', 'Name is required.'],
        error: 'Bad Request',
        code: 'validation',
      }),
      { status: 400 },
    );
    const failure = await readApiFailure(res);
    expect(failure.detail).toBe('Alias is too long. Name is required.');
    expect(failure.code).toBe('validation');
    expect(presentApiFailure('Could not create.', failure, statusLine).detail).toBe(
      'Alias is too long. Name is required.',
    );
  });

  it('shows a client exception without a stack', () => {
    const shown = presentClientFailure(
      'The layer could not be created.',
      new Error('crypto.randomUUID is not a function'),
    );
    expect(shown).toEqual({
      summary: 'The layer could not be created.',
      detail: 'crypto.randomUUID is not a function',
      requestId: null,
    });
    expect(
      sanitizePublicDetail(
        'boom\n    at createNewLayer (add-layer-dialog.tsx:92:24)',
      ),
    ).toBeNull();
    expect(
      presentClientFailure('Failed to read file.', new Error('boom\n    at read (file.ts:1:1)')),
    ).toEqual({
      summary: 'Failed to read file.',
      detail: null,
      requestId: null,
    });
  });
});
