// SPDX-License-Identifier: AGPL-3.0-or-later
import { BadRequestException } from '@nestjs/common';
import { PAPER_SIZE_INCHES, type PrintPaperSize } from '@gratis-gis/shared-types';

/**
 * The paper settings of a print template, checked.
 *
 * A template without paper settings prints on portrait Letter, as it
 * always has. When it is saved, settings that are there must name a
 * known size, and a valid orientation and margin when they give one;
 * anything else is a 400 with a plain message. Before a render starts
 * only the size is required: an unknown orientation prints portrait,
 * as it always did, and the margin is clamped to a usable range.
 */

const SIZES = Object.keys(PAPER_SIZE_INCHES) as PrintPaperSize[];
const ORIENTATIONS = ['portrait', 'landscape'] as const;

export interface CheckedPaper {
  size: PrintPaperSize;
  orientation: 'portrait' | 'landscape';
  /** Width and height in inches at the orientation. */
  inches: { w: number; h: number };
  /** The margin in inches, clamped by clampMarginIn. */
  marginIn: number;
}

/** The margin a template without one has. */
const DEFAULT_MARGIN_IN = 0.25;

const DEFAULT_PAPER: CheckedPaper = {
  size: 'letter',
  orientation: 'portrait',
  inches: { ...PAPER_SIZE_INCHES.letter },
  marginIn: DEFAULT_MARGIN_IN,
};

/**
 * A margin the sheet can use: a number from zero to a quarter of the
 * shorter side. Anything else (negative, too wide, not a number)
 * becomes the nearest usable value, or the default when it is not a
 * number at all.
 */
export function clampMarginIn(margin: unknown, inches: { w: number; h: number }): number {
  if (typeof margin !== 'number' || !Number.isFinite(margin)) return DEFAULT_MARGIN_IN;
  const most = Math.min(inches.w, inches.h) / 4;
  return Math.min(Math.max(margin, 0), most);
}

function isSize(v: unknown): v is PrintPaperSize {
  return typeof v === 'string' && (SIZES as string[]).includes(v);
}

function paperOf(data: unknown): unknown {
  return data !== null && typeof data === 'object'
    ? (data as { paper?: unknown }).paper
    : undefined;
}

/**
 * The paper a render uses, or a BadRequestException when the size is
 * unknown. Runs before a render takes a slot, so nothing the render
 * needs can fail later. Lenient where printing always was: an unknown
 * orientation is portrait and the margin is clamped.
 */
export function printTemplatePaper(data: unknown): CheckedPaper {
  const paper = paperOf(data);
  if (paper === undefined || paper === null) return DEFAULT_PAPER;
  if (typeof paper !== 'object' || Array.isArray(paper)) {
    throw new BadRequestException('The print template paper settings are not valid.');
  }
  const { size, orientation, marginIn } = paper as {
    size?: unknown;
    orientation?: unknown;
    marginIn?: unknown;
  };
  if (!isSize(size)) {
    throw new BadRequestException(
      `The print template paper size must be one of: ${SIZES.join(', ')}.`,
    );
  }
  const base = PAPER_SIZE_INCHES[size];
  const landscape = orientation === 'landscape';
  const inches = landscape ? { w: base.h, h: base.w } : { w: base.w, h: base.h };
  return {
    size,
    orientation: landscape ? 'landscape' : 'portrait',
    inches,
    marginIn: clampMarginIn(marginIn, inches),
  };
}

/**
 * Check a print template's `data` as it is saved: a known size, and a
 * valid orientation and margin when they are given.
 */
export function assertPrintTemplateData(data: unknown): void {
  printTemplatePaper(data);
  const paper = paperOf(data);
  if (paper === undefined || paper === null) return;
  const { orientation, marginIn } = paper as { orientation?: unknown; marginIn?: unknown };
  if (orientation !== undefined && !(ORIENTATIONS as readonly unknown[]).includes(orientation)) {
    throw new BadRequestException('The print template orientation must be portrait or landscape.');
  }
  if (
    marginIn !== undefined &&
    (typeof marginIn !== 'number' || !Number.isFinite(marginIn) || marginIn < 0)
  ) {
    throw new BadRequestException(
      'The print template margin must be a number of inches, zero or more.',
    );
  }
}
