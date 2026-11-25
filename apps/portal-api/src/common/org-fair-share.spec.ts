// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  fairShareBucket,
  FAIR_SHARE_WAIT_MEMORY_MS,
  OrgSlotCounter,
  runServingOrg,
} from './org-fair-share.js';
import { runAsAnonymous, runAsOrg, runAsSystem } from './tenant-context.js';
import { resetTenancyModeForTests } from './tenancy.js';

describe('fair share of a process-wide limit', () => {
  const before = process.env.GRATIS_TENANCY;
  afterEach(() => {
    if (before === undefined) delete process.env.GRATIS_TENANCY;
    else process.env.GRATIS_TENANCY = before;
    resetTenancyModeForTests();
  });

  function mode(m: 'single' | 'multi'): void {
    if (m === 'multi') process.env.GRATIS_TENANCY = 'multi';
    else delete process.env.GRATIS_TENANCY;
    resetTenancyModeForTests();
  }

  /** A counter on a clock the test moves. */
  function counter(): { c: OrgSlotCounter; clock: { t: number } } {
    const clock = { t: 1_000_000 };
    return { c: new OrgSlotCounter(() => clock.t), clock };
  }

  it('one organization: only the overall limit, as before', () => {
    mode('single');
    const { c } = counter();
    for (let i = 0; i < 4; i++) expect(c.tryTake(i % 2 ? 'org:a' : 'anonymous', 4)).toBe(true);
    expect(c.tryTake('org:b', 4)).toBe(false);
    c.release('org:a');
    expect(c.tryTake('org:a', 4)).toBe(true);
    expect(c.total()).toBe(4);
  });

  it('many organizations: one bucket alone gets the whole limit', () => {
    mode('multi');
    const { c } = counter();
    for (let i = 0; i < 8; i++) expect(c.tryTake('org:a', 8)).toBe(true);
    expect(c.tryTake('org:a', 8)).toBe(false);
    expect(c.heldBy('org:a')).toBe(8);
  });

  it('many organizations: two buckets under contention converge to their shares', () => {
    mode('multi');
    const { c } = counter();
    for (let i = 0; i < 8; i++) c.tryTake('org:a', 8);
    // Each round B asks while everything is held (and so counts as
    // waiting), then A finishes one and asks again: A is refused while
    // it holds more than B, and B's next try gets the slot.
    for (let round = 0; round < 6; round++) {
      expect(c.tryTake('org:b', 8)).toBe(false);
      c.release('org:a');
      const underShare = c.heldBy('org:a') < 4;
      expect(c.tryTake('org:a', 8)).toBe(underShare);
      if (c.total() < 8) expect(c.tryTake('org:b', 8)).toBe(true);
    }
    expect(c.heldBy('org:a')).toBe(4);
    expect(c.heldBy('org:b')).toBe(4);
  });

  it('many organizations: a waiting bucket is never starved', () => {
    mode('multi');
    const { c, clock } = counter();
    for (let i = 0; i < 2; i++) c.tryTake('org:a', 2);
    expect(c.tryTake('org:b', 2)).toBe(false);
    // A frees a slot and asks again at once: B is still waiting and
    // holds less, so the slot stays for B.
    c.release('org:a');
    expect(c.tryTake('org:a', 2)).toBe(false);
    clock.t += 1_000;
    expect(c.tryTake('org:b', 2)).toBe(true);
    expect(c.heldBy('org:b')).toBe(1);
  });

  it('many organizations: a bucket that stopped asking stops counting', () => {
    mode('multi');
    const { c, clock } = counter();
    c.tryTake('org:a', 2);
    c.tryTake('org:a', 2);
    expect(c.tryTake('org:b', 2)).toBe(false);
    c.release('org:a');
    clock.t += FAIR_SHARE_WAIT_MEMORY_MS + 1;
    // B gave up: A is alone again and may use the free slot.
    expect(c.tryTake('org:a', 2)).toBe(true);
  });

  it('many organizations: a caller line counts as waiting', () => {
    mode('multi');
    const { c } = counter();
    c.take('org:a');
    c.take('org:a');
    expect(c.mayTake('org:a', 4)).toBe(true);
    expect(c.mayTake('org:a', 4, ['org:b'])).toBe(false);
    expect(c.mayTake('org:b', 4, ['org:b'])).toBe(true);
  });

  it('many organizations: a refused bucket holding no more than another waiting one gets a free slot', () => {
    mode('multi');
    const { c } = counter();
    // Limit 8: A and B hold 2 and were turned away, C and D hold 1.
    for (const [b, n] of [
      ['org:a', 2],
      ['org:b', 2],
      ['org:c', 1],
      ['org:d', 1],
    ] as const) {
      for (let i = 0; i < n; i++) c.take(b);
    }
    for (let i = 0; i < 2; i++) c.take('org:x');
    expect(c.tryTake('org:a', 8)).toBe(false);
    expect(c.tryTake('org:b', 8)).toBe(false);
    c.release('org:x');
    c.release('org:x');
    // Two slots free: A and B each hold no more than the other.
    expect(c.tryTake('org:a', 8)).toBe(true);
    expect(c.tryTake('org:b', 8)).toBe(true);
    expect(c.total()).toBe(8);
  });

  describe('simulated interleavings', () => {
    /** Small seeded generator, so a failure can be replayed. */
    function rng(seed: number): () => number {
      let a = seed >>> 0;
      return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    }

    interface Outcome {
      results: boolean[];
      gotSlot: Set<string>;
      asked: Map<string, number>;
    }

    /**
     * Random asks, releases, clock steps and waiting lines against one
     * counter, checking the invariants after every step.
     */
    /** A plain assertion: much cheaper than expect() in a hot loop. */
    function check(ok: boolean, message: string): void {
      if (!ok) throw new Error(message);
    }

    function simulate(seed: number, limit: number, buckets: number, steps: number): Outcome {
      const rand = rng(seed);
      const { c, clock } = counter();
      const names = Array.from({ length: buckets }, (_, i) => `org:${i}`);
      const held = new Map(names.map((n) => [n, 0]));
      // Our own record of who counts as waiting: turned away recently
      // and not served since.
      const refusedAt = new Map<string, number>();
      const results: boolean[] = [];
      const gotSlot = new Set<string>();
      const asked = new Map<string, number>();
      const multi = process.env.GRATIS_TENANCY === 'multi';
      const total = (): number => [...held.values()].reduce((a, b) => a + b, 0);
      const waitingOthers = (b: string, line: readonly string[]): string[] => {
        const out = new Set(line.filter((x) => x !== b));
        for (const [x, at] of refusedAt) {
          if (x !== b && at >= clock.t - FAIR_SHARE_WAIT_MEMORY_MS) out.add(x);
        }
        return [...out];
      };
      const at = (step: number): string => `seed ${seed}, limit ${limit}, step ${step}`;
      /** A refusal with a free slot is allowed only for a strict leader. */
      const checkRefusal = (b: string, line: readonly string[], step: number): void => {
        if (total() >= limit) return;
        check(multi, `refused with a free slot, one organization (${at(step)})`);
        const others = waitingOthers(b, line);
        check(others.length > 0, `refused with a free slot and nobody waiting (${at(step)})`);
        for (const o of others) {
          check(
            held.get(b)! > held.get(o)!,
            `refused ${b} though ${o} holds as many (${at(step)})`,
          );
        }
      };

      for (let step = 0; step < steps; step++) {
        const b = names[Math.floor(rand() * buckets)]!;
        const r = rand();
        if (r < 0.1) {
          clock.t += Math.floor(rand() * 3 * FAIR_SHARE_WAIT_MEMORY_MS);
        } else if (r < 0.45) {
          if (held.get(b)! > 0) {
            c.release(b);
            held.set(b, held.get(b)! - 1);
          }
        } else if (r < 0.55) {
          // A caller with its own waiting line asks without taking.
          const line = names.filter(() => rand() < 0.3);
          const ok = c.mayTake(b, limit, line);
          results.push(ok);
          if (!ok) checkRefusal(b, line, step);
          else check(total() < limit, `allowed at the limit (${at(step)})`);
        } else {
          asked.set(b, (asked.get(b) ?? 0) + 1);
          const ok = c.tryTake(b, limit);
          results.push(ok);
          if (ok) {
            held.set(b, held.get(b)! + 1);
            refusedAt.delete(b);
            gotSlot.add(b);
          } else {
            checkRefusal(b, [], step);
            if (multi) refusedAt.set(b, clock.t);
          }
        }
        check(c.total() === total(), `total drifted (${at(step)})`);
        check(c.total() <= limit, `above the limit (${at(step)})`);
        for (const n of names) {
          check(
            c.heldBy(n) === held.get(n) && c.heldBy(n) >= 0,
            `count of ${n} wrong (${at(step)})`,
          );
        }
      }
      return { results, gotSlot, asked };
    }

    const cases: Array<[number, number]> = [];
    for (const limit of [1, 2, 3, 5, 8]) for (let n = 1; n <= 5; n++) cases.push([limit, n]);

    it.each(cases)(
      'many organizations, limit %i with %i buckets: never above the limit, no idle slot for a non-leader, nobody starves',
      (limit, buckets) => {
        mode('multi');
        for (let seed = 1; seed <= 40; seed++) {
          const { gotSlot, asked } = simulate(
            seed * 7919 + limit * 31 + buckets,
            limit,
            buckets,
            400,
          );
          // Every bucket that kept asking was served at least once.
          for (const [b, n] of asked) {
            if (n >= 10) check(gotSlot.has(b), `${b} asked ${n} times and was never served`);
          }
        }
      },
    );

    it.each([1, 3, 8])(
      'many organizations, limit %i: one bucket alone always gets every free slot',
      (limit) => {
        mode('multi');
        const { c } = counter();
        for (let round = 0; round < 50; round++) {
          while (c.total() < limit) expect(c.tryTake('org:a', limit)).toBe(true);
          expect(c.tryTake('org:a', limit)).toBe(false);
          c.release('org:a');
        }
      },
    );

    it.each(cases)(
      'one organization, limit %i with %i buckets: every answer is the plain limit check, as before',
      (limit, buckets) => {
        mode('single');
        for (let seed = 1; seed <= 20; seed++) {
          // checkRefusal inside asserts no refusal ever leaves a free
          // slot, so every answer equals "fewer than the limit held".
          simulate(seed * 104729 + limit + buckets, limit, buckets, 400);
        }
      },
    );

    it('many organizations: a waiting bucket gets the slots that busier buckets free', () => {
      mode('multi');
      const { c, clock } = counter();
      for (let i = 0; i < 4; i++) {
        c.take('org:a');
        c.take('org:c');
      }
      // Two rounds: after them B holds as many as the bucket that frees
      // the next slot, and the two are equals again.
      for (let round = 0; round < 2; round++) {
        // Earlier refusals of A and C are forgotten; B asks and waits.
        clock.t += FAIR_SHARE_WAIT_MEMORY_MS + 1;
        expect(c.tryTake('org:b', 8)).toBe(false);
        const busy = round % 2 ? 'org:a' : 'org:c';
        c.release(busy);
        clock.t += 10;
        // The busy bucket asks again at once; it holds more than B,
        // which waits, so the slot stays for B.
        expect(c.tryTake(busy, 8)).toBe(false);
        expect(c.tryTake('org:b', 8)).toBe(true);
      }
      expect(c.heldBy('org:b')).toBe(2);
    });
  });

  it('names the bucket from the tenant context', () => {
    expect(fairShareBucket()).toBe('none');
    expect(runAsOrg('o1', () => fairShareBucket())).toBe('org:o1');
    expect(runAsAnonymous(() => fairShareBucket())).toBe('anonymous');
    expect(runAsSystem('job-claim', () => fairShareBucket())).toBe('system');
  });

  it('signed-out work counts against the organization of the item it serves', () => {
    expect(runAsAnonymous(() => runServingOrg('o2', () => fairShareBucket()))).toBe('org:o2');
    expect(runAsAnonymous(() => runServingOrg(undefined, () => fairShareBucket()))).toBe(
      'anonymous',
    );
    // A signed-in caller always counts as its own organization.
    expect(runAsOrg('o1', () => runServingOrg('o2', () => fairShareBucket()))).toBe('org:o1');
  });
});
