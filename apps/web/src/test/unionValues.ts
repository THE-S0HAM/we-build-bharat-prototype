/**
 * Enumerating a backend union exhaustively in a test.
 *
 * Property 8 is a statement about *every* status in *every* domain, so its test
 * has to walk complete value lists. A list written out by hand falls behind
 * `src/types.ts` silently, which is the one failure mode that would leave the
 * property looking verified when it no longer is.
 *
 * So the lists are written as tables keyed on the union itself — the same
 * discipline `StatusBadge` and `RiskIndicator` use for their presentation
 * tables. A value added to a contract in `src/types.ts` is then a compile error
 * in the test file until it is listed. This helper turns such a table back into
 * its values, typed as the union rather than as `string`, so each one can be
 * handed straight back to the component as a prop.
 */

/** Every member of `K`, written as a table so the compiler can check the list. */
export type UnionTable<K extends string> = Record<K, true>;

/**
 * The members of `K` listed in `table`, in declaration order.
 *
 * `Object.keys` types its result as `string[]`, so the narrowing back to `K` is
 * stated once, here. `Object.hasOwn` is the evidence: the table's own type says
 * its keys are exactly `K`, and the guard confirms the key is one of them rather
 * than something inherited from `Object.prototype`.
 */
export function unionValues<K extends string>(table: UnionTable<K>): K[] {
  return Object.keys(table).filter((key): key is K => Object.hasOwn(table, key));
}
