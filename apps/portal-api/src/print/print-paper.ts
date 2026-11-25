// SPDX-License-Identifier: AGPL-3.0-or-later
import { BadRequestException } from '@nestjs/common';
import { PAPER_SIZE_INCHES, type PrintPaperSize } from '@gratis-gis/shared-types';

/**
 * The paper settings of a print template, checked.
 *
 * A template without paper settings prints on portrait Letter, as it
 * always has. Settings that are there must name a known size, and an
 * orientation and margin when they give one; anything else is a 400
 * with a plain message, when the template is saved and again before a
 * render starts.
 */

const SIZES = Object.keys(PAPER_SIZE_INCHES) as PrintPaperSize[];
const ORIENTATIONS = ['portrait', 'landscape'] as const;

export interface CheckedPaper {
  size: PrintPaperSize;
  orientation: 'portrait' | 'landscape';
  /** Width and height in inches at the orientation. */
  inches: { w: number; h: number };
}

const DEFAULT_PAPER: CheckedPaper = {
  size: 'letter',
  orientation: 'portrait',
  inches: { ...PAPER_SIZE_INCHES.letter },
};

function isSize(v: unknown): v is PrintPaperSize {
  return typeof v === 'string' && (SIZES as string[]).includes(v);
}

/**
 * The checked paper of a template's `data`, or a BadRequestException.
 * Used before a render, so nothing the render needs can fail later.
 */
export function printTemplatePaper(data: unknown): CheckedPaper {
  const paper =
    data !== null && typeof data === 'object' ? (data as { paper?: unknown }).paper : undefined;
  if (paper === undefined || paper === null) return DEFAULT_PAPER;
  if (typeof paper !== 'object' || Array.isArray(paper)) {
    throw new BadRequestException('The print template paper settings are not valid.');
  }
  const { size, orientation } = paper as { size?: unknown; orientation?: unknown };
  if (!isSize(size)) {
    throw new BadRequestException(
      `The print template paper size must be one of: ${SIZES.join(', ')}.`,
    );
  }
  if (orientation !== undefined && !(ORIENTATIONS as readonly unknown[]).includes(orientation)) {
    throw new BadRequestException('The print template orientation must be portrait or landscape.');
  }
  const base = PAPER_SIZE_INCHES[size];
  const landscape = orientation === 'landscape';
  return {
    size,
    orientation: landscape ? 'landscape' : 'portrait',
    inches: landscape ? { w: base.h, h: base.w } : { w: base.w, h: base.h },
  };
}

/**
 * Check a print template's `data` as it is saved: the paper as above,
 * plus the margin, which the preview page lays the sheet out with.
 */
export function assertPrintTemplateData(data: unknown): void {
  printTemplatePaper(data);
  const paper =
    data !== null && typeof data === 'object' ? (data as { paper?: unknown }).paper : undefined;
  if (paper === undefined || paper === null) return;
  const margin = (paper as { marginIn?: unknown }).marginIn;
  if (
    margin !== undefined &&
    (typeof margin !== 'number' || !Number.isFinite(margin) || margin < 0)
  ) {
    throw new BadRequestException(
      'The print template margin must be a number of inches, zero or more.',
    );
  }
}
