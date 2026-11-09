// SPDX-License-Identifier: AGPL-3.0-or-later
import { BadRequestException } from '@nestjs/common';

/**
 * Refuse a form save whose text `pattern` or `regex` question does
 * not compile as a JavaScript regular expression.
 *
 * The validator treats a bad pattern as a designer mistake and lets
 * the answer through, so a bad pattern never blocks a respondent. It
 * still means the format rule silently does nothing, so the author
 * hears about it when they save instead. XLSForm imports can carry
 * PCRE-only syntax, which is the usual way one gets in.
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
      try {
        new RegExp(`^(?:${q.pattern})$`, flags);
      } catch {
        bad.push(typeof q.id === 'string' ? q.id : '(unnamed)');
      }
    }
    if (Array.isArray(q.children)) walk(q.children, bad);
  }
}
