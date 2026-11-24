// SPDX-License-Identifier: AGPL-3.0-or-later
import 'reflect-metadata';
import { RequestMethod, type Type } from '@nestjs/common';
import {
  GUARDS_METADATA,
  METHOD_METADATA,
  MODULE_METADATA,
  PATH_METADATA,
} from '@nestjs/common/constants';

import { IS_PUBLIC_KEY } from '../../auth/public.decorator.js';

/**
 * Every HTTP route the API registers, found by reading the controller
 * decorators reachable from a root module. No module is instantiated
 * and nothing connects anywhere, so this runs in a plain unit test.
 *
 * Paths are written the way the router sees them: with the global
 * `api` prefix (except the routes main.ts excludes from it) and with
 * Express parameter names (`/api/items/:id`).
 */
export type DiscoveredRoute = {
  /** `GET /api/items/:id` */
  key: string;
  method: string;
  path: string;
  controller: string;
  handler: string;
  isPublic: boolean;
  guards: string[];
};

/** Paths main.ts serves without the `api` prefix. */
const PREFIX_EXCLUDED = new Set(['/health', '/docs']);

type ModuleRef =
  Type<unknown> | { module: Type<unknown>; controllers?: Type<unknown>[]; imports?: unknown[] };

function asArray(v: unknown): string[] {
  if (v === undefined || v === null) return [''];
  return Array.isArray(v) ? (v as string[]) : [String(v)];
}

function joinPath(...parts: string[]): string {
  const joined =
    '/' +
    parts
      .map((p) => p.replace(/^\/+|\/+$/g, ''))
      .filter((p) => p.length > 0)
      .join('/');
  return joined === '' ? '/' : joined;
}

function unwrap(entry: unknown): ModuleRef | undefined {
  if (!entry) return undefined;
  if (typeof entry === 'object' && 'forwardRef' in (entry as object)) {
    return unwrap((entry as { forwardRef: () => unknown }).forwardRef());
  }
  if (typeof entry === 'function') return entry as Type<unknown>;
  if (typeof entry === 'object' && 'module' in (entry as object)) return entry as ModuleRef;
  return undefined;
}

/** Controllers reachable from `root`, each once. */
export function discoverControllers(root: Type<unknown>): Type<unknown>[] {
  const seenModules = new Set<unknown>();
  const controllers = new Set<Type<unknown>>();
  const visit = (ref: ModuleRef | undefined): void => {
    if (!ref) return;
    const cls = typeof ref === 'function' ? ref : ref.module;
    const key = typeof ref === 'function' ? ref : ref;
    if (seenModules.has(key)) return;
    seenModules.add(key);
    const own =
      (Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, cls) as Type<unknown>[] | undefined) ?? [];
    const dyn = typeof ref === 'function' ? [] : (ref.controllers ?? []);
    for (const c of [...own, ...dyn]) controllers.add(c);
    const imports = [
      ...((Reflect.getMetadata(MODULE_METADATA.IMPORTS, cls) as unknown[] | undefined) ?? []),
      ...(typeof ref === 'function' ? [] : (ref.imports ?? [])),
    ];
    for (const imp of imports) visit(unwrap(imp));
  };
  visit(root);
  return [...controllers];
}

function guardNames(target: object): string[] {
  const guards = (Reflect.getMetadata(GUARDS_METADATA, target) as unknown[] | undefined) ?? [];
  return guards.map((g) =>
    typeof g === 'function'
      ? g.name
      : ((g as { constructor?: { name?: string } })?.constructor?.name ?? 'unknown'),
  );
}

/** Every route reachable from `root`, sorted by key. */
export function discoverRoutes(root: Type<unknown>): DiscoveredRoute[] {
  const out = new Map<string, DiscoveredRoute>();
  for (const ctrl of discoverControllers(root)) {
    const ctrlPaths = asArray(Reflect.getMetadata(PATH_METADATA, ctrl));
    const ctrlPublic = Reflect.getMetadata(IS_PUBLIC_KEY, ctrl) === true;
    const ctrlGuards = guardNames(ctrl);
    const proto = ctrl.prototype as Record<string, unknown>;
    const names = new Set<string>();
    for (let p: object | null = proto; p && p !== Object.prototype; p = Object.getPrototypeOf(p)) {
      for (const n of Object.getOwnPropertyNames(p)) names.add(n);
    }
    for (const name of names) {
      if (name === 'constructor') continue;
      const desc =
        Object.getOwnPropertyDescriptor(proto, name) ??
        Object.getOwnPropertyDescriptor(Object.getPrototypeOf(proto), name);
      const fn = desc?.value as unknown;
      if (typeof fn !== 'function') continue;
      const methodPath = Reflect.getMetadata(PATH_METADATA, fn) as unknown;
      const method = Reflect.getMetadata(METHOD_METADATA, fn) as RequestMethod | undefined;
      if (methodPath === undefined || method === undefined) continue;
      const verb = RequestMethod[method] ?? String(method);
      for (const cp of ctrlPaths) {
        for (const mp of asArray(methodPath)) {
          const bare = joinPath(cp, mp);
          const path = PREFIX_EXCLUDED.has(bare) ? bare : joinPath('api', bare);
          const key = `${verb} ${path}`;
          out.set(key, {
            key,
            method: verb,
            path,
            controller: ctrl.name,
            handler: name,
            isPublic: ctrlPublic || Reflect.getMetadata(IS_PUBLIC_KEY, fn) === true,
            guards: [...ctrlGuards, ...guardNames(fn)],
          });
        }
      }
    }
  }
  return [...out.values()].sort((a, b) => a.key.localeCompare(b.key));
}
