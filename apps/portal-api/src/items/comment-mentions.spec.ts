// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  commentSnippet,
  extractMentionUsernames,
  MAX_MENTIONS_PER_COMMENT,
} from './comment-mentions.js';

describe('comment-mentions', () => {
  it('extracts unique @usernames in first-seen order', () => {
    expect(extractMentionUsernames('hi @Alice and @bob then @alice')).toEqual([
      'Alice',
      'bob',
    ]);
  });

  it('ignores email-like tokens', () => {
    expect(extractMentionUsernames('ping name@host.com and @real')).toEqual([
      'real',
    ]);
  });

  it('caps at MAX_MENTIONS_PER_COMMENT', () => {
    const parts = Array.from(
      { length: MAX_MENTIONS_PER_COMMENT + 5 },
      (_, i) => `@u${i}`,
    );
    expect(extractMentionUsernames(parts.join(' '))).toHaveLength(
      MAX_MENTIONS_PER_COMMENT,
    );
  });

  it('snippet collapses whitespace and truncates', () => {
    expect(commentSnippet('  hello\n\nworld  ')).toBe('hello world');
    expect(commentSnippet('x'.repeat(200), 20).endsWith('…')).toBe(true);
  });
});
