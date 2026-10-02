/**
 * The appState an export is rendered with.
 *
 * Two things here are not cosmetic:
 *
 * 1. **`exportEmbedScene: true`.** Without it, Excalidraw writes a picture: a PNG
 *    whose only chunks are IHDR/IDAT/IEND, and an SVG whose only comment is the
 *    always-present `svg-source:excalidraw` marker. Both open fine, but they open
 *    as *an image*, not as the diagram — nothing to edit. With it, the scene JSON
 *    rides along inside the file (a `tEXt` chunk for PNG, a comment for SVG) and
 *    the file re-imports as elements. Verified by inspecting the bytes of an
 *    actual export, which is how the gap was found.
 *
 * 2. **`exportBackground` explicit.** `exportToSvg`'s own signature requires it,
 *    and relying on the live appState's value would make the output depend on a
 *    UI toggle that nobody set on purpose.
 *
 * `exportEmbedScene` lives *inside* `appState` — `ExportOpts.appState` is
 * `Partial<Omit<AppState, ...>>` — so it is set here rather than as a sibling
 * option. Passing it at the top level is silently ignored, which would look like
 * the feature simply not working.
 *
 * Pure and exported so the flags can be asserted without a canvas: the actual
 * rendering needs a browser, but "did we ask for the scene to be embedded" does
 * not.
 */
export function exportAppState(appState) {
  return {
    ...(appState && typeof appState === "object" ? appState : {}),
    exportEmbedScene: true,
    exportBackground: true,
  };
}

/**
 * Files to hand the exporter.
 *
 * `ExportOpts.files` is required (not optional) and is the binary map for `image`
 * elements. This app excludes `image` elements by design (开发记录 §1: they need a
 * separate `api.addFiles()` step and the 0.18.1 `SceneData` has no `files` field),
 * so the map is always empty — but it must be passed, not omitted.
 */
export const EXPORT_FILES = Object.freeze({});
