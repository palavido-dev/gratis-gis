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
  // Two ESM-only dependency trees reach AppModule and so have to be
  // downleveled for the CommonJS test runtime:
  //
  //   jose v6            <- jwks-rsa -> JwtStrategy -> AuthModule
  //   puppeteer-core v25 <- PrintRenderService -> PrintRenderModule
  //
  // Neither ships a CJS build. Node >=22.12 can `require()` an ESM
  // module, which is why production boots fine; Jest's CommonJS
  // runtime cannot, and fails with "SyntaxError: Unexpected token
  // 'export'" or "Cannot use import statement outside a module".
  // Transforming them is the honest fix. Stubbing via moduleNameMapper
  // would also go green, but would mean app.module.spec.ts never loads
  // the real module, and that boot test is the whole point.
  //
  // `@puppeteer` and `chromium-bidi` are puppeteer-core's own ESM-only
  // dependencies that its entry point pulls in eagerly. The rest of
  // that tree (zod, yargs, modern-tar) is only reached from the
  // browser-download path we never touch, so it stays untransformed.
  //
  // Read the pattern as "ignore everything under node_modules whose
  // path does not mention one of these". The negative lookahead has to
  // span the whole remainder because pnpm nests the real package at
  // node_modules/.pnpm/jose@6.2.3/node_modules/jose/...: a narrower
  // pattern would still match at the inner node_modules and the file
  // would go untransformed.
  transformIgnorePatterns: ['node_modules/(?!.*(jose|puppeteer-core|@puppeteer|chromium-bidi))'],
};
