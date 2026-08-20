// SPDX-License-Identifier: AGPL-3.0-or-later
// Jest configuration for form-schema unit tests.
//
// This package had no test runner, which mattered more than it looked
// like it did: the validator here decides whether a respondent's
// submission is accepted, and a mistake in it is a form nobody can
// send rather than an error anyone can see. That is exactly what
// happened with required questions of a type no runtime can capture.
//
// Mirrors shared-types' config: same ts-jest preset, same `.js`
// import rewrite so a source file's `./foo.js` resolves to `./foo.ts`
// under CommonJS.
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
