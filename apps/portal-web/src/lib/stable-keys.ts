// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * React keys for a list whose items carry no id of their own, kept in
 * step with inserts and removals.
 *
 * Keying by index hands one row's component state to its neighbour
 * when a row is inserted or removed above it: the derived-layer
 * builder showed step 1's cached preview on step 2's card after step 1
 * was removed. These keys move with their row instead.
 */
export class StableKeys {
  private keys: string[] = [];
  private next = 0;

  private mint(): string {
    this.next += 1;
    return `k${this.next}`;
  }

  /** Keys for a list of `length`, padding or trimming at the end for
   *  changes that did not come through insert/remove (a reset, a
   *  load). */
  for(length: number): readonly string[] {
    while (this.keys.length < length) this.keys.push(this.mint());
    if (this.keys.length > length) this.keys.length = length;
    return this.keys;
  }

  insert(index: number): void {
    this.keys.splice(index, 0, this.mint());
  }

  remove(index: number): void {
    this.keys.splice(index, 1);
  }
}
