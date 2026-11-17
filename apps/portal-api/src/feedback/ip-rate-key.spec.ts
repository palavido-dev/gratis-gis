// SPDX-License-Identifier: AGPL-3.0-or-later
import { hashIp, rateKey } from './ip-hash.js';

/** One IPv6 subscriber holds a /64: count it as one source. */
describe('feedback rate key', () => {
  it('cuts IPv6 to its /64 and keeps IPv4 whole', () => {
    expect(rateKey('2001:db8:1:2:aaaa::1')).toBe('2001:db8:1:2::/64');
    expect(rateKey('2001:db8:1:2:bbbb:cccc:dddd:eeee')).toBe('2001:db8:1:2::/64');
    expect(rateKey('2001:db8::1')).toBe('2001:db8:0:0::/64');
    expect(rateKey('::ffff:203.0.113.9')).toBe('203.0.113.9');
    expect(rateKey('203.0.113.9')).toBe('203.0.113.9');
  });

  it('gives two addresses of one /64 the same hash', () => {
    expect(hashIp('2001:db8:1:2::a')).toBe(hashIp('2001:db8:1:2::b'));
    expect(hashIp('203.0.113.9')).not.toBe(hashIp('203.0.113.10'));
  });
});
