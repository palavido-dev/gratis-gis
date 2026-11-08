// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from 'node:assert/strict';
import { decideOrigin } from './origin-preflight.mjs';

const lan = decideOrigin('192.168.1.20:8080', 'http://192.168.1.20:8080');
assert.equal(lan.allowed, true);

const tail = decideOrigin('nas.tail1234.ts.net', 'http://192.168.1.20:8080');
assert.equal(tail.allowed, false);
assert.match(tail.lines.join('\n'), /Tailscale Serve/);
assert.equal(tail.suggested, 'https://nas.tail1234.ts.net');

const bad = decideOrigin('100.1.2.3:8080', 'http://192.168.1.20:8080');
assert.match(bad.lines.join('\n'), /GRATIS_BASE_URL: http:\/\/100.1.2.3:8080/);

console.log('origin preflight ok');
