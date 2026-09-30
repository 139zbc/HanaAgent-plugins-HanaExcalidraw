/**
 * Reading the host's light/dark, without assuming the host told us.
 *
 * Why this exists: the plugin iframe URL is stamped by the host with
 * `hana-theme-appearance`, but only conditionally —
 *
 *   ```js
 *   const r = ei(themeId);
 *   if (!r) return;                                  // no appearance, no param
 *   url.searchParams.set("hana-theme-appearance", r);
 * ```
 *
 * A theme that does not declare an appearance gets no parameter, the SDK's
 * snapshot carries `appearance: undefined`, and a card that reads
 * `appearance === "dark" ? "dark" : "light"` is then permanently light. It does
 * not fail visibly, which is the worst part: there is no error, no event, and
 * nothing to retry. The canvas simply never follows.
 *
 * So the declared field is treated as a hint, and the host's actual stylesheet
 * is treated as the truth. The host injects its theme CSS into the plugin frame
 * (`<style data-hana-theme-style>`), and that CSS is what the user is looking
 * at — measuring it cannot disagree with the app the way a missing field can.
 *
 * Precedence, in order:
 *
 *   1. `appearance` from the snapshot, when it is actually present. Cheapest and
 *      authoritative when the host bothers to send it.
 *   2. The luminance of the host's own background token. This is the fallback
 *      that actually carries the feature — but only once
 *      `syncHostThemeAttribute` has made the host's stylesheet match something.
 *   3. Light. What the canvas already was, and a card that repaints itself dark
 *      on a guess is a surprise rather than a match.
 *
 * The attribute is the load-bearing part. Every shipped theme except the default
 * is written as `[data-theme="<id>"]` with no bare `:root` rule — of the ten
 * themes on disk only `warm-paper.css` carries `:root:not([data-theme])`. The
 * SDK reports the active id but never sets the attribute, so in a plugin frame
 * the host's sheet matches **nothing** and the only thing defining `--bg` is
 * this app's own light fallback. Without the attribute, step 2 is a tautology:
 * it reports what this file says, not what the host says.
 */

/** The attribute every host theme selector is written against. */
export const THEME_ATTR = "data-theme";

/**
 * Put the host's active theme id on the document element.
 *
 * This is what makes the host stylesheet apply at all. It is also what makes
 * every other host token work in the card — `--text`, `--border-muted`, the
 * spacing and radius scale — so the card's own chrome stops depending on
 * hand-copied light values and starts using the theme the user actually picked.
 *
 * Deliberately never *clears* the attribute. An absent attribute is what lets
 * the default theme's `:root:not([data-theme])` rule apply, so removing it would
 * be a change rather than a no-op. When the host has not given us an id there is
 * nothing to say either way, and leaving the page as it is keeps the last known
 * theme on screen instead of snapping back to the default.
 */
export function syncHostThemeAttribute(themeId, doc) {
  const el = doc?.documentElement;
  if (!el) return;
  const id = typeof themeId === "string" ? themeId.trim() : "";
  if (!id) return;
  if (el.getAttribute(THEME_ATTR) === id) return;
  el.setAttribute(THEME_ATTR, id);
}

/**
 * Background tokens to try, most reliable first.
 *
 * `--bg` is the host's app canvas; `--sidebar-bg` is the left rail. They agree
 * on appearance in every shipped theme, and either one is enough. The raw
 * fallbacks only apply when the host injected no CSS at all.
 */
const BACKGROUND_VARS = ["--bg", "--sidebar-bg", "--bg-card"];

/** Where a background token's value can come from, in the same order. */
const RAW_FALLBACKS = ["--bg", "--sidebar-bg", "--bg-card"];

/**
 * Classify a CSS colour by how much light is in it.
 *
 * Deliberately not a colour library. The input is a host design token, so it is
 * always a hex or an rgb/rgba literal, and the only question is whether it reads
 * as a light or a dark surface to a human. Relative luminance from the sRGB
 * primaries is the standard weighting for that, and the 0.5 cut is the usual
 * mid-grey. The exact value sitting on the cut is `#808080` (128/255 = 0.502);
 * note that CSS's own "mid grey" `#767676` is *below* it at 0.463, and so reads
 * as dark. That is correct, not an off-by-one — a surface at #767676 is darker
 * than the light backgrounds it would have to be confused with.
 *
 * Exported separately from the DOM access so it can be tested without a browser.
 */
export function classifyLuminance(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;

  const rgb = parseColor(raw);
  if (!rgb) return null;

  // Rec. 709 luminance, in 0..1.
  const luminance = (0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]) / 255;
  return luminance >= 0.5 ? "light" : "dark";
}

/** `#rgb`, `#rrggbb`, `#rrggbbaa`, `rgb()`, `rgba()`. Anything else is null. */
function parseColor(value) {
  const text = value.trim().toLowerCase();

  if (text.startsWith("#")) {
    const hex = text.slice(1);
    // Strip an alpha suffix: the canvas ignores it and a theme that sets
    // `#1e1e1eff` is still opaque.
    const body = hex.length === 8 || hex.length === 4 ? hex.slice(0, hex.length === 8 ? 6 : 3) : hex;
    if (body.length === 3) {
      const [r, g, b] = body.split("");
      return [parseInt(r + r, 16), parseInt(g + g, 16), parseInt(b + b, 16)];
    }
    if (body.length === 6 && /^[0-9a-f]{6}$/.test(body)) {
      return [
        parseInt(body.slice(0, 2), 16),
        parseInt(body.slice(2, 4), 16),
        parseInt(body.slice(4, 6), 16),
      ];
    }
    return null;
  }

  const fn = text.match(/^rgba?\(([^)]+)\)$/);
  if (fn) {
    const parts = fn[1].split(/[\s,/]+/).filter(Boolean).slice(0, 3);
    if (parts.length < 3) return null;
    const [r, g, b] = parts.map((p) => (p.endsWith("%") ? (parseFloat(p) / 100) * 255 : parseFloat(p)));
    return [r, g, b].every((n) => Number.isFinite(n)) ? [r, g, b] : null;
  }

  return null;
}

/**
 * The theme snapshot's declared appearance, or null when it did not declare one.
 *
 * The distinction matters. `undefined` means "the host was silent", which sends
 * the caller to the stylesheet; folding it into "light" is what made the canvas
 * stuck.
 */
export function declaredAppearance(snapshot) {
  const raw = snapshot?.appearance;
  return raw === "dark" || raw === "light" ? raw : null;
}

/**
 * Measure the appearance from the host's own CSS, in a document.
 *
 * Pass `null` for `doc` to skip the DOM entirely (tests, or a non-browser host).
 */
export function measureAppearance(doc) {
  if (!doc?.documentElement || typeof getComputedStyle !== "function") return null;

  let style;
  try {
    style = getComputedStyle(doc.documentElement);
  } catch {
    return null;
  }

  for (const name of BACKGROUND_VARS) {
    const declared = classifyLuminance(style.getPropertyValue(name));
    if (declared) return declared;
  }
  return null;
}

/**
 * The whole decision, in one place, so the card and the sidebar cannot drift.
 */
export function resolveAppearance(snapshot, doc) {
  return declaredAppearance(snapshot) ?? measureAppearance(doc) ?? "light";
}

/** Test-only: the raw token names, so a test can assert they are not inlined wrong. */
export const BACKGROUND_VAR_NAMES = Object.freeze([...BACKGROUND_VARS, ...RAW_FALLBACKS]);

export { RAW_FALLBACKS as RAW_BACKGROUND_VARS };
