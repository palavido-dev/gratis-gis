// SPDX-License-Identifier: AGPL-3.0-or-later
// Jest configuration for portal-web unit tests.
//
// portal-web had no test runner at all, which is why the offline
// arc's most consequential code shipped untested: the queue fold that
// stops an offline edit destroying the capture it edits, the atomic
// claim, the attachment lifecycle. The pure decision tables were
// pushed into shared-types to get SOME coverage, and that worked, but
// it cannot reach the part that actually talks to IndexedDB, which is
// where the transactions and the ordering live.
//
// Scope is deliberately narrow. This is NOT a React component test
// setup: no testing-library, no renderer, no jsdom DOM assertions
// beyond what IndexedDB needs. It exists to cover `src/lib`, the
// storage and sync layer, and the testMatch below says so. Component
// tests are a bigger decision (which library, how much mocking of
// MapLibre) and would arrive with their own reasoning.
//
// The node environment, not jsdom, and that is the right call rather
// than a convenience. IndexedDB is defined in terms of the structured
// clone algorithm, and storing a Blob is exactly what the attachment
// tests do. Node implements structuredClone and Blob natively and
// they work together; jsdom implements neither structuredClone nor a
// Blob that Node's algorithm can clone, so under jsdom a stored file
// came back as a plain object with no bytes. Teaching a hand-written
// clone function about Blobs would mean the suite exercises a
// serialiser written for the suite, which is the one property that
// would make it worthless. Nothing in src/lib touches the DOM.
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: '.',
  // src/lib only, on purpose. See above.
  testMatch: ['<rootDir>/src/lib/**/*.spec.ts'],
  setupFiles: ['<rootDir>/jest.setup.cjs'],
  // A production build leaves a whole second copy of the workspace in
  // .next/standalone, package.json included, and jest's module map
  // then reports a naming collision against the real one. Nothing
  // under .next is a source file.
  modulePathIgnorePatterns: ['<rootDir>/.next/'],
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
    '^@gratis-gis/shared-types$':
      '<rootDir>/../../packages/shared-types/src/index.ts',
    '^@gratis-gis/form-schema$':
      '<rootDir>/../../packages/form-schema/src/index.ts',
  },
  transform: {
    '^.+\\.tsx?$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.jest.json' }],
  },
};
