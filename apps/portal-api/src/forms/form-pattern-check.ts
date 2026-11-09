// SPDX-License-Identifier: AGPL-3.0-or-later
import { BadRequestException } from '@nestjs/common';
import { RegExpValidator } from '@eslint-community/regexpp';

/** Longest format pattern a form may carry. */
export const MAX_FORM_PATTERN_LENGTH = 2_000;

/**
 * Refuse a form save whose text `pattern` or `regex` question is not
 * a valid JavaScript regular expression.
 *
 * The validator treats a bad pattern as a designer mistake and lets
 * the answer through, so a bad pattern never blocks a respondent. It
 * still means the format rule silently does nothing, so the author
 * hears about it when they save instead. XLSForm imports can carry
 * PCRE-only syntax, which is the usual way one gets in.
 *
 * The syntax is checked with a parser, without compiling the author's
 * pattern here. Patterns longer than MAX_FORM_PATTERN_LENGTH are
 * refused too, since every one of them runs on respondent input.
 *
 * Walks every question, including group and repeat children. Anything
 * that is not form-shaped passes, as with the engine stamp.
 */
export function assertFormPatternsCompile(data: unknown): void {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return;
  const questions = (data as { questions?: unknown }).questions;
  if (!Array.isArray(questions)) return;
  const bad: string[] = [];
  walk(questions, bad);
  if (bad.length > 0) {
    throw new BadRequestException(
      `These questions have a format pattern that is not a valid regular expression: ${bad.join(', ')}.`,
    );
  }
}

function walk(questions: unknown[], bad: string[]): void {
  for (const raw of questions) {
    if (!raw || typeof raw !== 'object') continue;
    const q = raw as {
      id?: unknown;
      type?: unknown;
      pattern?: unknown;
      flags?: unknown;
      children?: unknown;
    };
    if ((q.type === 'text' || q.type === 'regex') && typeof q.pattern === 'string' && q.pattern) {
      const flags = q.type === 'regex' && typeof q.flags === 'string' ? q.flags : '';
      if (q.pattern.length > MAX_FORM_PATTERN_LENGTH || !patternParses(q.pattern, flags)) {
        bad.push(typeof q.id === 'string' ? q.id : '(unnamed)');
      }
    }
    if (Array.isArray(q.children)) walk(q.children, bad);
  }
}

/** True when `^(?:pattern)$` with `flags` is valid ECMAScript regex syntax. */
function patternParses(pattern: string, flags: string): boolean {
  const validator = new RegExpValidator({ ecmaVersion: 2025 });
  const source = `^(?:${pattern})$`;
  try {
    validator.validateFlags(flags);
    const unicode = flags.includes('u');
    const unicodeSets = flags.includes('v');
    validator.validatePattern(source, 0, source.length, { unicode, unicodeSets });
    return true;
  } catch {
    return false;
  }
}
