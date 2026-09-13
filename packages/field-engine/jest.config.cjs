// SPDX-License-Identifier: AGPL-3.0-or-later
// The one suite here builds the bundle and runs it inside a bare
// `node:vm` context (ES builtins only, no console, no timers, no
// TextEncoder), which is the closest thing Node offers to the
// embedded engine on the phone. A function that works from TypeScript
// but not from the bundle is exactly the bug this exists to catch.
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
