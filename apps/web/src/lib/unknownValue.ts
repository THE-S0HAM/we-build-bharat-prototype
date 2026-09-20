/**
 * Reading a presentation table with a value the type system trusts but the
 * network has not proved.
 *
 * `apiFetch<T>` in `src/api.ts` asserts the shape of a response rather than
 * validating it, so every union in `src/types.ts` is a *declared* contract, not
 * a verified one. A backend that starts returning a status outside the union
 * reaches a component as a value its table has no entry for.
 *
 * Indexing a `Record<Union, V>` with such a value returns `undefined` at
 * runtime even though TypeScript types the result as `V` — `noUncheckedIndexedAccess`
 * only adds `| undefined` for index signatures, not for a record keyed on a
 * finite union. Destructuring that `undefined` throws during render and takes
 * the whole page down. A page showing one honest, unstyled-looking badge is
 * strictly better than a blank screen.
 *
 * These two helpers keep the tables themselves exhaustive: a table stays
 * `Record<Union, V>`, so a *known* union member without an entry is still a
 * compile error. The guard here is against unknown runtime values only.
 */

/**
 * Read `value` from `table` without trusting that the key is present.
 *
 * `Object.hasOwn` is the check rather than a truthiness test on the result, so a
 * value naming something on `Object.prototype` (`"constructor"`, `"toString"`)
 * resolves as absent instead of returning a function.
 *
 * @returns the entry, or `undefined` when the table has no own entry for `value`.
 */
export function readTableEntry<K extends string, V>(
  table: Record<K, V>,
  value: K,
): V | undefined {
  return Object.hasOwn(table, value) ? table[value] : undefined;
}

/**
 * Turn an unrecognised backend enum value into readable label text.
 *
 * Every status, level and severity in `src/types.ts` is spelled in
 * SCREAMING_SNAKE_CASE, so separators become spaces and the tail lower-cases:
 * `AWAITING_PAYMENT` reads as "Awaiting payment". That keeps requirements 12.9
 * and 15.10 satisfied — the badge still carries a text label — without the
 * screen showing something that looks like a raw internal token.
 *
 * @returns the humanised text, or `null` when `value` carries no readable
 * content and the caller should use its own fallback copy instead.
 */
export function humaniseUnknownValue(value: string): string | null {
  // Typed as `string`, but this function exists precisely because the value is
  // unverified: a JSON `null` or number would otherwise throw on `.replace`.
  if (typeof value !== "string") {
    return null;
  }

  const words = value.replace(/[_-]+/g, " ").trim().replace(/\s+/g, " ");

  if (words === "") {
    return null;
  }

  const lower = words.toLowerCase();

  return `${lower.charAt(0).toUpperCase()}${lower.slice(1)}`;
}
