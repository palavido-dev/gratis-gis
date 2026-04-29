import { BadRequestException } from '@nestjs/common';
import type { ToolStep } from '@gratis-gis/shared-types';

import { bufferGenerator } from './buffer.js';
import type { ToolGenerator } from './types.js';

/**
 * Central tool registry. Adding a new tool is purely additive: write
 * a generator file, import it here, and add an entry to the map. The
 * derived-layers service iterates the registry through `getGenerator`
 * so it never imports individual tool files directly.
 *
 * The runtime types use `ToolGenerator<unknown>` because the registry
 * holds heterogeneous tools. Per-call narrowing happens through the
 * `validate(...)` method on each generator: callers pass the raw
 * params off the wire and get back a strongly-typed value.
 */
const REGISTRY: Map<string, ToolGenerator<unknown>> = new Map([
  [bufferGenerator.kind, bufferGenerator as ToolGenerator<unknown>],
]);

/**
 * Look up a generator by `kind`. Throws `BadRequestException` for
 * unknown kinds so the wizard / API gets a clear 400 instead of a
 * runtime crash if a client sends a tool name the server doesn't
 * recognize.
 */
export function getGenerator(kind: string): ToolGenerator<unknown> {
  const g = REGISTRY.get(kind);
  if (!g) {
    throw new BadRequestException(`Unknown derived-layer tool: ${kind}`);
  }
  return g;
}

/**
 * Discriminator helper for typed `ToolStep` unions: returns the
 * registered generator for a step's kind. Pulled out so call sites
 * read as `getGeneratorForStep(step)` rather than poking the
 * discriminator manually.
 */
export function getGeneratorForStep(
  step: ToolStep,
): ToolGenerator<unknown> {
  return getGenerator(step.tool);
}

/**
 * Snapshot of every registered tool kind. Used by tests + the
 * `/admin/health` surface (future) so a deployment can list
 * available analysis tools without crawling source.
 */
export function listRegisteredTools(): string[] {
  return Array.from(REGISTRY.keys());
}
