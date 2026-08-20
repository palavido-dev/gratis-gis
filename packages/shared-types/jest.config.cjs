// SPDX-License-Identifier: AGPL-3.0-or-later
// Jest configuration for shared-types unit tests.
//
// This package had no test runner at all, which was tolerable while
// it held only type declarations. It no longer does: the custom-app
// schema migration lives here, it rewrites every existing app's
// widget bindings on load, and a mistake in it is a silently wrong
// layer rather than an error. That needs tests that actually run.
//
// Mirrors portal-api's config minus everything it needs for Nest:
// same ts-jest preset, same `.js` import rewrite so a source file's
// `./foo.js` resolves to `./foo.ts` under CommonJS.
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: '.',
  testMatch: ['<rootDir>/src/**/*.spec.ts'],
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.json' }],
  },
};
