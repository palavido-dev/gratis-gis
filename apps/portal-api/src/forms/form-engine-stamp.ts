// SPDX-License-Identifier: AGPL-3.0-or-later
import { requiredEngineVersion } from '@gratis-gis/form-schema';
import type { FormSchema } from '@gratis-gis/form-schema';

/**
 * Stamp `requiredEngineVersion` onto a form item's data on write.
 *
 * The value is derived from the form's content, so it is server
 * state in the same sense `linkedLayerId` is: whatever the client
 * sent is replaced, never trusted. A native field client compares
 * the stamp with the engine build it carries and refuses to capture
 * against a form that needs a newer one. The web client and the
 * server always run the current engine, so for them the stamp is
 * informational.
 *
 * Pure and total: anything that is not a form-shaped object is
 * returned as-is, because the items service validates shape
 * elsewhere and this must never be the thing that 500s a save.
 */
export function stampFormEngineVersion(data: unknown): unknown {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return data;
  const form = data as Record<string, unknown>;
  if (!Array.isArray(form.questions)) return data;
  return {
    ...form,
    requiredEngineVersion: requiredEngineVersion(form as unknown as FormSchema),
  };
}
