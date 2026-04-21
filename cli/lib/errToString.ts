/**
 * Convert an unknown thrown value into a safe display string.
 * Using `(e as Error).message` directly is unsafe: JS allows throwing any
 * value, and `.message` on a non-Error is `undefined`, which renders as the
 * literal "undefined" in error surfaces.
 */
export const errToString = (e: unknown): string =>
  e instanceof Error ? e.message : String(e)
