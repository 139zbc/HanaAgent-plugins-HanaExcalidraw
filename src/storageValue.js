/**
 * Unwrap one App-storage read.
 *
 * Why this file exists at all: the card-side `hana.storage.global.get(key)`
 * answers the host's `AppStorageGetResult` — `{ key, value }` — **not** the value
 * that was written. Confirmed three ways, because a wrong answer here is silent:
 *
 *   1. the generated SDK type (`AppStorageGetResult { key: string; value: unknown }`),
 *   2. the SDK's own runtime, which resolves the host's payload untouched
 *      (`@hana/plugin-sdk/browser.js`: `resolve(message.payload)` — no unwrap), and
 *   3. an installed App that hit it in production and wrote the trap down
 *      (`mineru-document-workbench/ui/assets/sidebar.js`: "实测坑").
 *
 * Reading `result.boardId` off that wrapper yields `undefined` every single
 * time, and `undefined` reads as a legitimate "nothing stored yet". So the code
 * that depended on it did not fail — it quietly became "always the default",
 * which is indistinguishable from correct behaviour until you look for the
 * thing it was supposed to remember. (PLAN.md R57.)
 *
 * The trap is that the **server-side** `sdk.storage.global.get` really does
 * return the bare value: its declared type is `get(key, fallback?) => unknown`,
 * and it is a direct in-process object rather than a protocol round trip. Same
 * method name, two shapes, depending on which side of the card you are on. So
 * this unwrapper is deliberately forgiving in both directions rather than
 * assuming either one: if a future host version starts handing back the bare
 * value, nothing here starts returning `null`.
 */

/**
 * @param {unknown} raw Whatever the storage read resolved to.
 * @returns {unknown} The stored value, or `null` when there is none.
 */
export function unwrapStored(raw) {
  if (raw === null || raw === undefined) return null;
  // A bare string is stored as-is by some writers, and must survive untouched.
  if (typeof raw !== "object") return raw;
  // Not a wrapper: a stored object/array. Returning it whole is what keeps this
  // from eating real values once the host stops wrapping.
  if (!("value" in raw)) return raw;
  const inner = raw.value;
  // Tolerate a double wrap. Cheap, and the failure it prevents is another
  // silent `undefined` rather than an error.
  if (inner !== null && typeof inner === "object" && "value" in inner && !Array.isArray(inner)) {
    return inner.value ?? null;
  }
  return inner ?? null;
}
