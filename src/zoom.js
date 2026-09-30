/**
 * Viewport zoom arithmetic, kept pure so it can be tested.
 *
 * Zoom is a *view* operation, so it is legitimate even in the read-only in-chat
 * preview: it changes what the user sees, not the document. Nothing here touches
 * elements.
 *
 * The one non-obvious part is the anchor. Excalidraw's transform is
 * `viewport = (scene + scroll) * zoom`, so setting `zoom` alone keeps `scroll`
 * fixed and the content appears to zoom toward the top-left corner. To pin the
 * scene point at the middle of the viewport, scroll has to compensate:
 *
 *     sceneX_center = width / (2 * zoomOld) - scrollX
 *     scrollX_new   = width / (2 * zoomNew) - sceneX_center
 *                   = scrollX + (width / 2) * (1/zoomNew - 1/zoomOld)
 *
 * The same for the vertical axis, with height.
 */

/** Excalidraw's own zoom bounds. */
export const MIN_ZOOM = 0.1;
export const MAX_ZOOM = 30;

/** Zoom steps that match Excalidraw's own zoom-in/out increments. */
const ZOOM_STEPS = [0.1, 0.15, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1, 1.2, 1.5, 2, 3, 4, 5, 8, 10, 15, 20, 30];

/** The next step up or down from `value`. Clamped, and always one step. */
export function steppedZoom(value, direction) {
  const current = Number.isFinite(value) && value > 0 ? value : 1;
  if (direction > 0) {
    const next = ZOOM_STEPS.find((s) => s > current + 1e-6);
    return next ?? MAX_ZOOM;
  }
  // Walk down from the top so a value between steps lands on the step below it.
  let prev = MIN_ZOOM;
  for (const s of ZOOM_STEPS) {
    if (s < current - 1e-6) prev = s;
    else break;
  }
  return prev;
}

/**
 * The appState patch for a zoom change, anchored at the viewport centre.
 *
 * Dimensions come from `appState.width/height`, which Excalidraw fills once the
 * component has measured itself. Missing or zero width falls back to no
 * compensation, which zooms from the corner — degraded, but not broken.
 */
export function zoomPatch(appState, nextZoom) {
  const clamp = (v) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, v));
  const zoomOld = Number.isFinite(appState?.zoom?.value) && appState.zoom.value > 0 ? appState.zoom.value : 1;
  const zoomNew = clamp(Number.isFinite(nextZoom) ? nextZoom : zoomOld);
  const width = Number.isFinite(appState?.width) ? appState.width : 0;
  const height = Number.isFinite(appState?.height) ? appState.height : 0;

  const patch = { zoom: { value: zoomNew } };
  if (zoomNew !== zoomOld && width > 0 && height > 0) {
    const k = 0.5 * (1 / zoomNew - 1 / zoomOld);
    patch.scrollX = (Number.isFinite(appState?.scrollX) ? appState.scrollX : 0) + width * k;
    patch.scrollY = (Number.isFinite(appState?.scrollY) ? appState.scrollY : 0) + height * k;
  }
  return patch;
}

/** Human-readable percentage for the button label. */
export function zoomPercent(value) {
  const z = Number.isFinite(value) && value > 0 ? value : 1;
  return `${Math.round(z * 100)}%`;
}
