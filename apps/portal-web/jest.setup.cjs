// SPDX-License-Identifier: AGPL-3.0-or-later
// A real IndexedDB implementation for the storage tests.
//
// fake-indexeddb implements the spec rather than mocking it:
// transactions serialise, key ranges work, and a read-modify-write
// race behaves the way the browser would. That matters here, because
// the things worth testing in this layer ARE the transaction
// semantics. A hand-rolled stub would pass whatever it was written to
// pass and would have caught none of the bugs this suite exists for.
//
// Everything else it needs (structuredClone, Blob, crypto) is a Node
// global, which is why these tests run in the node environment rather
// than jsdom. See jest.config.cjs.
require('fake-indexeddb/auto');
