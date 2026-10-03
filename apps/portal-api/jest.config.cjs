// SPDX-License-Identifier: AGPL-3.0-or-later
// Jest configuration for portal-api unit tests.
//
// The codebase uses TypeScript with `.js`-suffixed imports
// (Node's "node16-esm-style" convention) but the runtime module
// setting is CommonJS. ts-jest's `useESM: false` plus the moduleNameMapper
// rewrite below lets a test like `import './foo.js'` resolve to the
// underlying `./foo.ts` without requiring real ESM at test time.
//
// Workspace packages (`@gratis-gis/shared-types`, etc.) are pointed
// directly at their `src/` entry so a test never has to wait for the
// dependent package's build.
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: '.',
  testMatch: ['<rootDir>/src/**/*.spec.ts'],
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
    '^@gratis-gis/shared-types$': '<rootDir>/../../packages/shared-types/src/index.ts',
    '^@gratis-gis/form-schema$': '<rootDir>/../../packages/form-schema/src/index.ts',
  },
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.json' }],
    // `jose` (below) is plain modern JS and needs downleveling to CJS.
    '^.+\\.js$': [
      'ts-jest',
      {
        tsconfig: {
          allowJs: true,
          module: 'commonjs',
          target: 'es2022',
          // jose ships no CJS types and does not need checking here.
          checkJs: false,
          esModuleInterop: true,
        },
      },
    ],
  },
  // NestJS 12, jose, and puppeteer-core are ESM-only. The test script
  // starts Node with `--experimental-vm-modules`, which is what lets
  // Jest evaluate those packages instead of downleveling them to
  // CommonJS. Transforming them used to be required and now breaks:
  // ts-jest emits `exports`, and Jest then evaluates that file as ESM.
  transformIgnorePatterns: ['/node_modules/'],
};
