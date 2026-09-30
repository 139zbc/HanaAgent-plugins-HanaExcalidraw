import { hana } from "@hana/plugin-sdk";

/**
 * Thin wrapper over the Hana browser SDK.
 *
 * Step 0 rendered Excalidraw without ever talking to the host, which is why the
 * card looked alive but was reported as `webView.mounted: false` and refused
 * every `ui_action`. Handshaking is also the precondition for
 * `setInteractiveRegions`, without which the floating host titlebar sits on top
 * of Excalidraw's own top-row controls.
 *
 * Every call is defensive: the same page is expected to survive being opened
 * outside a host (plain dev server, exported card), where `ready` throws.
 */

let hostReady = false;
const listeners = new Set();

function notify() {
  for (const fn of listeners) {
    try {
      fn(hostReady);
    } catch {
      /* a listener must not take the page down */
    }
  }
}

export function onHostReady(fn) {
  listeners.add(fn);
  if (hostReady) fn(true);
  return () => listeners.delete(fn);
}

export function isHostReady() {
  return hostReady;
}

/** Handshake with the host. Safe to call more than once. */
export function connectHost() {
  if (hostReady) return;
  try {
    hana.ready();
    hostReady = true;
  } catch (err) {
    // Not a host-mounted surface. The board still works, it just has no bridge.
    console.warn("[excalidraw] no Hana host bridge:", err?.message || err);
  }
  notify();
}

/* ------------------------------------------------------------------ *
 * Keep the host titlebar off our controls
 * ------------------------------------------------------------------ */

const REGION_LIMIT = 64;
const PAD = 6;

function rectOf(el, pad = PAD) {
  if (!el) return null;
  const r = el.getBoundingClientRect();
  if (r.width <= 0 || r.height <= 0) return null;
  const x = Math.max(0, Math.round(r.left - pad));
  const y = Math.max(0, Math.round(r.top - pad));
  const width = Math.min(1_000_000, Math.round(r.width + pad * 2));
  const height = Math.min(1_000_000, Math.round(r.height + pad * 2));
  if (width <= 0 || height <= 0) return null;
  return { x, y, width, height };
}

/**
 * Report only the rectangles that actually hold controls. Declaring the whole
 * top strip would leave the host titlebar with nowhere to drag the card, which
 * is exactly what the host contract warns against.
 */
export function collectInteractiveRegions() {
  const selectors = [
    ".layer-ui__wrapper__top-left", // library + element buttons
    ".excalidraw-toolbar", // centred tool palette
    ".layer-ui__wrapper__top-right", // canvas menu
    ".excalidraw-mobile-toolbar", // narrow layout moves the palette to the bottom
    ".layer-ui__wrapper__bottom-right", // zoom / help cluster
  ];
  const out = [];
  const seen = new Set();
  for (const sel of selectors) {
    const el = document.querySelector(sel);
    const rect = rectOf(el);
    if (!rect) continue;
    const key = `${rect.x},${rect.y},${rect.width},${rect.height}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(rect);
    if (out.length >= REGION_LIMIT) break;
  }
  return out;
}

let lastKey = "";
let pending = 0;
export const regionReport = { applied: 0, refused: [], last: null };

export async function syncInteractiveRegions() {
  if (!hostReady) return;
  cancelAnimationFrame(pending);
  pending = requestAnimationFrame(async () => {
    const regions = collectInteractiveRegions();
    const key = JSON.stringify(regions);
    if (key === lastKey) return; // layout churn must not spam the host
    lastKey = key;
    try {
      await hana.surface.setInteractiveRegions(regions);
      regionReport.applied += 1;
      regionReport.refused = [];
      regionReport.last = regions;
    } catch (err) {
      regionReport.refused.push(String(err?.code || err?.message || err));
      console.warn("[excalidraw] setInteractiveRegions refused:", err?.message || err);
    }
  });
}

/* ------------------------------------------------------------------ *
 * Quiet activity log — lets the agent read board state later
 * ------------------------------------------------------------------ */

export async function track(name, payload) {
  if (!hostReady) return;
  try {
    await hana.track(name, payload);
  } catch (err) {
    console.warn("[excalidraw] track refused:", err?.message || err);
  }
}
