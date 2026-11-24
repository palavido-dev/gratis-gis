// SPDX-License-Identifier: AGPL-3.0-or-later
import { BadRequestException } from '@nestjs/common';

import { AREA_ID_RE } from '../area-of-interest/area-input.js';

/**
 * The body of POST /whats-here/report (#796), checked by hand like
 * area-input.ts: the shape is nested and a 400 that names the bad part
 * is worth more here than a generic validator message.
 *
 * The client sends what to report on and how to present it. It never
 * sends the numbers: the server reads every layer again under the
 * caller's own access, so a report always says what the caller could
 * see at the moment it was made.
 */

export const REPORT_AREA_UNITS = [
  'square-meters',
  'hectares',
  'square-kilometers',
  'square-feet',
  'acres',
  'square-miles',
] as const;
export const REPORT_LENGTH_UNITS = ['meters', 'kilometers', 'feet', 'miles'] as const;
export type ReportAreaUnit = (typeof REPORT_AREA_UNITS)[number];
export type ReportLengthUnit = (typeof REPORT_LENGTH_UNITS)[number];

/** Layers one report covers. A screen of more is not a site screen. */
export const MAX_REPORT_LAYERS = 30;
/** Largest map picture, as a data URL. A 1600 px JPEG is ~400 KB. */
export const MAX_MAP_IMAGE_CHARS = 6 * 1024 * 1024;
/** Picked shapes named in the report. */
export const MAX_PICKED_LABELS = 200;

/** Every label the report prints, in the caller's language. */
export const REPORT_LABEL_KEYS = [
  'title',
  'generated',
  'area',
  'distance',
  'onlyInside',
  'place',
  'picked',
  'layer',
  'count',
  'areaCol',
  'lengthCol',
  'percentCol',
  'nothingIn',
  'breakdownBy',
  'noValue',
  'unavailable',
  'truncated',
] as const;
export type ReportLabels = Record<(typeof REPORT_LABEL_KEYS)[number], string>;

export interface ReportLayerRequest {
  itemId: string;
  layerKey: string;
  title: string;
  breakdownField?: string;
}

export interface ReportRequest {
  areaId: string;
  distanceMeters: number;
  layers: ReportLayerRequest[];
  areaUnit: ReportAreaUnit;
  lengthUnit: ReportLengthUnit;
  paper: 'letter' | 'a4';
  locale: string;
  /** IANA zone the "made" time is printed in. */
  timeZone: string;
  labels: ReportLabels;
  title?: string;
  place?: string;
  picked: string[];
  mapImage?: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEY_RE = /^[A-Za-z0-9_.-]{1,100}$/;
const FIELD_RE = /^[A-Za-z_][A-Za-z0-9_.]{0,99}$/;
// BCP 47 enough for Intl: "en", "en-US", "pt-BR", "zh-Hant-TW".
const LOCALE_RE = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8}){0,3}$/;
const IMAGE_RE = /^data:image\/(png|jpeg);base64,[A-Za-z0-9+/]+=*$/;

function validZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

function bad(msg: string): never {
  throw new BadRequestException(msg);
}

function text(v: unknown, name: string, max: number, required = false): string | undefined {
  if (v === undefined || v === null || v === '') {
    if (required) bad(`${name} is required.`);
    return undefined;
  }
  if (typeof v !== 'string') bad(`${name} must be text.`);
  if (v.length > max) bad(`${name} is longer than ${max} characters.`);
  return v;
}

export function parseReportRequest(body: unknown): ReportRequest {
  if (!body || typeof body !== 'object' || Array.isArray(body)) bad('Send a JSON object.');
  const b = body as Record<string, unknown>;

  if (typeof b.areaId !== 'string' || !AREA_ID_RE.test(b.areaId)) {
    bad('areaId must be an id returned by POST /api/areas-of-interest.');
  }
  const distance = b.distanceMeters ?? 0;
  if (typeof distance !== 'number' || !Number.isFinite(distance) || distance < 0) {
    bad('distanceMeters must be a number of meters, 0 or more.');
  }

  if (!Array.isArray(b.layers) || b.layers.length === 0) bad('Pick at least one layer.');
  if (b.layers.length > MAX_REPORT_LAYERS) bad(`A report covers at most ${MAX_REPORT_LAYERS} layers.`);
  const layers = b.layers.map((raw, i): ReportLayerRequest => {
    if (!raw || typeof raw !== 'object') bad(`layers[${i}] must be an object.`);
    const l = raw as Record<string, unknown>;
    if (typeof l.itemId !== 'string' || !UUID_RE.test(l.itemId)) bad(`layers[${i}].itemId must be a UUID.`);
    if (typeof l.layerKey !== 'string' || !KEY_RE.test(l.layerKey)) bad(`layers[${i}].layerKey is not a layer key.`);
    const title = text(l.title, `layers[${i}].title`, 200, true)!;
    const field = text(l.breakdownField, `layers[${i}].breakdownField`, 100);
    if (field !== undefined && !FIELD_RE.test(field)) bad(`layers[${i}].breakdownField is not a field name.`);
    return {
      itemId: l.itemId,
      layerKey: l.layerKey,
      title,
      ...(field ? { breakdownField: field } : {}),
    };
  });

  if (!REPORT_AREA_UNITS.includes(b.areaUnit as ReportAreaUnit)) bad('areaUnit is not a known unit.');
  if (!REPORT_LENGTH_UNITS.includes(b.lengthUnit as ReportLengthUnit)) bad('lengthUnit is not a known unit.');
  const paper = b.paper === undefined ? 'letter' : b.paper;
  if (paper !== 'letter' && paper !== 'a4') bad('paper must be letter or a4.');
  const locale = b.locale === undefined ? 'en-US' : b.locale;
  if (typeof locale !== 'string' || !LOCALE_RE.test(locale)) bad('locale is not a language tag.');

  const timeZone = b.timeZone === undefined ? 'UTC' : b.timeZone;
  if (typeof timeZone !== 'string' || timeZone.length > 64 || !validZone(timeZone)) {
    bad('timeZone is not a known time zone.');
  }

  if (!b.labels || typeof b.labels !== 'object') bad('labels is required.');
  const rawLabels = b.labels as Record<string, unknown>;
  const labels = Object.fromEntries(
    REPORT_LABEL_KEYS.map((k) => [k, text(rawLabels[k], `labels.${k}`, 300, true)!]),
  ) as ReportLabels;

  const picked = b.picked === undefined ? [] : b.picked;
  if (!Array.isArray(picked) || picked.length > MAX_PICKED_LABELS) {
    bad(`picked must be a list of at most ${MAX_PICKED_LABELS} names.`);
  }
  const pickedNames = picked.map((p, i) => text(p, `picked[${i}]`, 200, true)!);

  const mapImage = text(b.mapImage, 'mapImage', MAX_MAP_IMAGE_CHARS);
  if (mapImage !== undefined && !IMAGE_RE.test(mapImage)) {
    bad('mapImage must be a PNG or JPEG data URL.');
  }

  const title = text(b.title, 'title', 200);
  const place = text(b.place, 'place', 500);
  return {
    areaId: b.areaId,
    distanceMeters: distance,
    layers,
    areaUnit: b.areaUnit as ReportAreaUnit,
    lengthUnit: b.lengthUnit as ReportLengthUnit,
    paper,
    locale,
    timeZone,
    labels,
    picked: pickedNames,
    ...(title ? { title } : {}),
    ...(place ? { place } : {}),
    ...(mapImage ? { mapImage } : {}),
  };
}
