import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Excalidraw,
  CaptureUpdateAction,
  convertToExcalidrawElements,
  restoreAppState,
  restoreElements,
  exportToBlob,
  exportToSvg,
} from "@excalidraw/excalidraw";
import { parseMermaidToExcalidraw } from "@excalidraw/mermaid-to-excalidraw";
import "@excalidraw/excalidraw/index.css";
import "./board.css";
import {
  connectHost,
  onHostReady,
  regionReport,
  syncInteractiveRegions,
  track,
} from "./hostBridge.js";
import {
  DEFAULT_BOARD_ID,
  deliverExport,
  loadBoard,
  loadBoardScene,
  probePreview,
  publishBoardStatus,
  readActiveBoard,
  saveBoardScene,
  subscribeBoardCommand,
  subscribeBoardPulse,
  switchBoard,
  uploadExport,
} from "./boardClient.js";
import { EXPORT_FILES, exportAppState } from "./exportOptions.js";
import { hostStorage, installMermaidBridge } from "./mermaidBridge.js";
import { installRenderBridge } from "./renderBridge.js";
import { MAX_ZOOM, MIN_ZOOM, steppedZoom, zoomPatch, zoomPercent } from "./zoom.js";
import { resolveAppearance, syncHostThemeAttribute } from "./hostTheme.js";
import { hana } from "@hana/plugin-sdk";

/**
 * The whiteboard surface.
 *
 * Step 0 proved Excalidraw renders and stays interactive inside a Hana card.
 * Step 1 made the drawing survive a reload. Steps 2–3 made the same board
 * writable by the agent: this page listens for changes to its board key and
 * paints them, which is the whole "agent draws, you keep drawing" loop.
 * Step 4 added the Function Panel, the in-chat preview, and export.
 *
 * Everything below is verified against the installed 0.18.1 type definitions
 * rather than the docs site: the published prop table lags the source, and it
 * both lists props that do not exist in 0.18.1 and omits behaviour we rely on.
 *
 * NOTE: keep this filename distinct from the entry files in every case. A
 * `Board.jsx` / `board.jsx` pair collided on case-insensitive filesystems —
 * Vite normalized the import back onto the entry itself, the component was
 * silently replaced, and the card rendered a permanently blank canvas.
 */

const SAVE_DEBOUNCE_MS = 1200;
const ECHO_WINDOW_MS = 400;

/** How long a one-line outcome stays up before the panel takes it back. */
const NOTICE_MS = 8000;

/**
 * How long "someone else wrote to this board" stays on the canvas.
 *
 * It asks nothing and offers nothing, so unlike the conflict banner — which
 * holds two buttons and must wait for a decision — it is allowed to leave on
 * its own. Without this it never left at all: `remoteRev` had no path that ever
 * cleared it, so one remote write turned a line of text into permanent
 * furniture sitting over the drawing.
 */
const REMOTE_BANNER_MS = 6000;

/**
 * Excalidraw 0.18.1 filters the entire canvas in dark mode with
 * `invert(93%) hue-rotate(180deg)`. The stored background is the *unfiltered*
 * pixel colour: white becomes the official near-black on screen. Setting the
 * stored colour to #1e1e1e instead made the visible canvas light grey.
 * #1e1e1e is recognized only to migrate that earlier mistaken default.
 */
const DEFAULT_CANVAS_BACKGROUND = "#ffffff";
const LEGACY_DARK_BACKGROUND = "#1e1e1e";

/** The host's current light/dark, or light when it cannot say. */
function readHostAppearance() {
  try {
    const snapshot = hana.theme?.getSnapshot?.();
    // Set the attribute *before* measuring. Every host theme is written against
    // `[data-theme="<id>"]` and matches nothing until this runs, so measuring
    // first reads this app's own light fallback and answers "light" every time.
    syncHostThemeAttribute(snapshot?.theme, document);
    return resolveAppearance(snapshot, document);
  } catch (err) {
    // No theme surface on this slot, or the snapshot could not be read. Light is
    // the safer default: it is what the canvas already was, and a card that
    // silently repaints itself dark would be a surprise rather than a match.
    // Said out loud on purpose — a silent catch here hid a missing import for
    // three releases, because the failure is a ReferenceError, not a wrong
    // value, and there is nothing in the UI to point at it.
    console.warn("[excalidraw] host theme unavailable, falling back to light:", err);
    return "light";
  }
}

/**
 * In-chat preview: read-only, no dock, no toolbar, no panel.
 *
 * Chosen two ways, because there are two ways to arrive here:
 *   - `?preview=1`, for a card opened directly with that query; and
 *   - the `readOnly` prop, used by the dedicated `preview.html` entry.
 *
 * The prop is the one that matters for the in-chat card. The host does not hand a
 * messageRenderer card any payload or query (its contract says so explicitly),
 * so a card pointed at `/board.html` would arrive fully editable -- which is the
 * wrong affordance for "here is a picture of what the agent drew". `preview.html`
 * is its own card declaration with this flag baked in.
 */
function isPreviewQuery() {
  return new URLSearchParams(window.location.search).get("preview") === "1";
}

export default function ExcalidrawBoard({ boardId = DEFAULT_BOARD_ID, readOnly = false }) {
  const preview = useMemo(() => readOnly || isPreviewQuery(), [readOnly]);
  const shellRef = useRef(null);
  const [api, setApi] = useState(null);
  const [count, setCount] = useState(0);
  const [host, setHost] = useState(false);
  const [status, setStatus] = useState("loading");
  const [remoteRev, setRemoteRev] = useState(null);
  const [conflictDraft, setConflictDraft] = useState(null);
  const [activeId, setActiveId] = useState(boardId);
  /**
   * Light or dark, taken from the host.
   *
   * The app has a theme and the whiteboard lives inside it, so a canvas that
   * follows something else is a white sheet in a dark window. Seeded from the
   * host's own snapshot rather than from the system, because those are two
   * different things: a light app on a dark OS is a real combination, and
   * following the OS is what produces a bright canvas nobody asked for.
   */
  const [theme, setTheme] = useState(readHostAppearance);
  // The preview's live zoom, fed by Excalidraw's own scroll/zoom notifications so
  // a pinch or wheel gesture updates the readout too.
  const [zoom, setZoom] = useState(1);
  const [exporting, setExporting] = useState("");
  /**
   * One line of user-facing outcome, shown at the top of the panel.
   *
   * This exists because the debug line it replaces was the only feedback an
   * action had: `setStatus` strings ("saved r191", "export failed", "file op
   * failed") were technical diagnostics, and the only surface painting them was
   * a step-0 probe over the canvas. Four carefully separated export outcomes
   * (PLAN.md R41) went there and reached nobody.
   */
  const [notice, setNotice] = useState(null);

  const apiRef = useRef(null);
  const themeCheckTimer = useRef(0);
  const saveTimer = useRef(0);
  const echoTimer = useRef(0);
  const echoRef = useRef(false);
  const pendingScene = useRef(null);
  const myRev = useRef(0);
  /**
   * The board whose scene is actually on the canvas.
   *
   * This is NOT the same as the requested `activeId`, and the difference is what
   * corrupted four boards: `initialData` always painted `main`, Excalidraw's own
   * async `initializeScene` could land after an `updateScene`, and the autosave
   * then wrote whatever was on the canvas into whatever `activeId` said. Four
   * boards ended up with `main`'s 36 elements.
   *
   * So the canvas content carries its owner, and every save targets that owner.
   * A scene captured for one board can never be written to another.
   */
  const loadedBoardId = useRef(null);
  /** Monotonic token so a slow board load cannot paint over a newer one. */
  const loadToken = useRef(0);
  // Excalidraw reflows text once its webfonts land, which fires onChange without
  // the user having touched anything. Saving that would bump the revision on
  // every single page open, so the first moments after load are ignored.
  const settleUntil = useRef(Number.POSITIVE_INFINITY);

  /**
   * `initialData` is read exactly once, during Excalidraw's own async
   * `initializeScene` (PLAN.md R13). It used to resolve the *prop* board — always
   * `main` — and leave the real active board to a later `updateScene`. Those two
   * async paths raced, and when `initializeScene` won, the canvas kept `main`
   * while the app believed a different board was active.
   *
   * Resolving the real active board here removes the race at its source: the
   * first paint is already the right scene, so there is nothing to be overtaken
   * by. A preview card stays pinned to the board it was shared from.
   */
  const [initialData] = useState(() => {
    const resolve = preview
      ? Promise.resolve(boardId)
      : readActiveBoard().then((id) => id || boardId).catch(() => boardId);
    return resolve.then(async (id) => {
      loadedBoardId.current = id;
      const scene = await loadBoardScene(id);
      return scene;
    });
  });

  // 0.17+ dropped ref support; this callback is the only way in. Assigning it
  // must stay idempotent because React may invoke it more than once.
  const onApi = useCallback((instance) => {
    apiRef.current = instance ?? null;
    setApi(instance ?? null);
  }, []);

  /**
   * Push the host's theme into Excalidraw.
   *
   * `theme` is part of Excalidraw's appState, so this is an `updateScene` rather
   * than a remount — which matters, because remounting would re-run
   * `initializeScene` and repaint from `initialData`, i.e. throw away the
   * viewport and any unsaved strokes on a theme change.
   *
   * Two details that are easy to get wrong:
   *
   *   - **The canvas colour follows only if it was a default.** A board whose
   *     background is `#fef9ef` was given that on purpose; repainting it because
   *     the app went dark would be the app overruling a choice the user made in
   *     the one place they can make it.
   *   - **It must not look like an edit.** `updateScene` fires `onChange`, and the
   *     autosave would write a new revision, signal every open window and
   *     repaint them — for a colour change. `settleUntil` is the existing "this
   *     was not the user" guard, and the window is short because nothing is
   *     reflowing here the way webfonts reflow after a load.
   *
   * A function rather than an effect body, because **running it once is not
   * enough**. `applyRemoteScene` ends in `restoreAppState(scene.appState)`,
   * which merges the *file's* appState over the current one: `viewBackgroundColor`
   * is in that file, so every paint — the initial one, a board switch, an agent
   * edit — put the stored background straight back. `theme` is not persisted, so
   * it survived, and the result was a dark toolbar over a white canvas: the half
   * state that made this look like a theme bug in the first place. Whatever
   * repaints has to be followed by another reconcile.
   */
  const reconcileTheme = useCallback(
    (editor) => {
      const target = editor ?? apiRef.current;
      if (!target?.updateScene) return;

      const current = target.getAppState?.();
      const currentBg = current?.viewBackgroundColor;
      const isDefault = !currentBg || currentBg === DEFAULT_CANVAS_BACKGROUND || currentBg === LEGACY_DARK_BACKGROUND;
      const next = isDefault ? DEFAULT_CANVAS_BACKGROUND : currentBg;

      // Nothing to do. Re-pushing an identical appState is not free: it fires
      // `onChange` and re-renders the canvas, and this runs after every paint.
      if (current?.theme === theme && currentBg === next) return;

      // Swallow our own onChange — but only when nothing else already is.
      //
      // `applyRemoteScene` sets an echo window around its own `updateScene`, and
      // this call happens inside that window, so extending `settleUntil` there
      // buys nothing. What it costs is real: 400ms of *every* user edit dropped,
      // on any repaint, including an agent edit landing while someone is
      // mid-stroke. Inside an echo the saving is already handled; outside one
      // there is no echo to ride on, so the guard is what keeps a colour change
      // from being written as a revision.
      if (!echoRef.current) {
        settleUntil.current = Math.max(settleUntil.current, Date.now() + 400);
      }
      target.updateScene({
        appState: { theme, viewBackgroundColor: next },
        // Same reasoning as `applyRemoteScene`: this is not the user editing, and
        // it must not land in their undo stack.
        collaborators: undefined,
        captureUpdate: "never",
      });
    },
    [theme],
  );

  useEffect(() => {
    if (preview) return;
    reconcileTheme();
    // `api` is a dep and not an afterthought: Excalidraw hands over its API
    // during an async initialize, so on the first render `apiRef.current` is
    // still null and this would run against nothing. Watching only `theme` left
    // the first paint in the wrong theme until the user toggled the app's theme
    // twice — the subscribe fires immediately on mount and the set is a no-op
    // the second time, so nothing ever re-ran it.
  }, [api, preview, reconcileTheme]);

  /**
   * Paint a scene that somebody else wrote. Two things make this safe:
   * `restoreElements` because `updateScene` documents that it expects already
   * normalized elements, and `NEVER` so the agent's work never lands in the
   * user's undo stack — otherwise one Ctrl+Z silently deletes a diagram.
   */
  const applyRemoteScene = useCallback((scene) => {
    const editor = apiRef.current;
    if (!editor || !scene) return;
    const elements = restoreElements(scene.elements ?? [], null, { repairBindings: true });
    const appState = restoreAppState(scene.appState ?? {}, null);
    // updateScene re-enters through onChange; swallow exactly that echo so the
    // autosave does not write the agent's own scene straight back (PLAN.md R10).
    echoRef.current = true;
    clearTimeout(echoTimer.current);
    echoTimer.current = setTimeout(() => {
      echoRef.current = false;
    }, ECHO_WINDOW_MS);
    editor.updateScene({ elements, appState, captureUpdate: CaptureUpdateAction.NEVER });

    // Put the theme back after the paint, not before it.
    //
    // `restoreAppState` merged the file's appState over the live one, and the
    // file carries `viewBackgroundColor` — so this line is what puts a stored
    // light canvas back on screen. It is the same shape as the `activeTool`
    // re-assertion below and for the same reason: an ordering fix, because
    // setting it once when the API arrived lost the race against the first
    // paint. Setting it after every paint also covers an agent edit repainting
    // the board.
    //
    // It is deliberately *not* awaited before the `activeTool` line: both are
    // idempotent `updateScene` calls, and neither reads what the other wrote.
    reconcileTheme(editor);
    // Re-assert the preview's tool *after* the paint.
    //
    // `restoreAppState` returns a complete appState, including its
    // `activeTool: { type: "selection" }` default, so every paint resets the tool.
    // Setting it once when the API arrived was not enough: the initial paint ran
    // afterwards and put it back (observed, via `ui:previewProbe`: requested
    // `hand`, settled on `selection`). Doing it here covers the initial paint and
    // every later one, which matters because an agent edit repaints too.
    //
    // `setActiveTool` does apply — its body ends in `setState({ activeTool })` —
    // so this is an ordering fix, not a workaround.
    if (preview && typeof editor.setActiveTool === "function") {
      editor.setActiveTool({ type: "hand" });
      // Read the *settled* value: `setState` is asynchronous, so reading straight
      // after the call reports the previous tool and says nothing about whether it
      // worked.
      setTimeout(() => {
        const applied = apiRef.current?.getAppState?.()?.activeTool?.type ?? null;
      probePreview({ outcome: "hand-tool", requested: "hand", activeTool: applied });
      }, 120);
    }
    // `reconcileTheme` closes over the current theme, so it belongs here: without
    // it this callback keeps the theme it was created with, and keeps
    // re-asserting a stale background long after the app has gone dark.
  }, [preview, reconcileTheme]);

  /**
   * Fit a freshly loaded board to the card.
   *
   * The board no longer stores where the viewport was (see `PERSISTED_APP_STATE`
   * in boardStore.js), so opening one has to decide where to look. Content is the
   * answer: a board opens showing its drawing, whole.
   *
   * Called from the two places a board *arrives* — the initial load and a switch —
   * and deliberately from nowhere else. An agent editing the board repaints through
   * `pullRemote` too, and fitting there would yank the viewport out from under
   * whatever the user was reading; the point of the feature is to not do that.
   *
   * Two guards, both about "there is nothing to fit":
   *   - an empty scene (or one with only deleted elements) has no bounds, and
   *     asking Excalidraw to fit a degenerate box zooms to nonsense;
   *   - a card that is not on screen yet reports a zero-sized container, so the
   *     fit would be computed against nothing. Skipping it means a hidden card
   *     simply keeps the default view until it is shown and reloaded.
   *
   * `animate: false` because this is the *initial* framing of a board, not a
   * response to a click: a slow pan-zoom on arrival reads as a glitch, and it
   * would also make the result depend on when an animation happens to finish.
   */
  const fitSceneToContent = useCallback((sceneElements) => {
    const elements = (Array.isArray(sceneElements) ? sceneElements : []).filter((e) => !e?.isDeleted);
    if (!elements.length) return;
    const attempt = (retriesLeft) => {
      const editor = apiRef.current;
      if (!editor || typeof editor.scrollToContent !== "function") return;
      const { width = 0, height = 0 } = editor.getAppState?.() ?? {};
      if (width <= 0 || height <= 0) {
        // The card is open but has not been laid out yet (a background tab, the
        // first mount tick). A couple of short retries are worth it: without them a
        // long board silently stays parked at its top-left corner, which looks
        // exactly like the bug this feature is fixing.
        if (retriesLeft > 0) setTimeout(() => attempt(retriesLeft - 1), 80);
        return;
      }
      editor.scrollToContent(elements, { fitToContent: true, animate: false });
    };
    // Five tries ≈ 400 ms. A preview card is the case that needs them: it has no
    // second paint to fall back on, and its API can arrive after `initialData`.
    attempt(5);
  }, []);

  /**
   * The live canvas, as `{ elements, appState }`.
   *
   * Deliberately the *canvas* and not the stored board: the agent is asking what its
   * drawing looks like, and the canvas is the only thing that has ever been rendered.
   */
  const snapshotCanvas = useCallback(() => {
    const editor = apiRef.current;
    if (!editor) return { elements: [], appState: {} };
    return {
      elements: editor.getSceneElements?.() ?? [],
      appState: editor.getAppState?.() ?? {},
    };
  }, []);

  /**
   * Rasterize for the agent's own eyes, not for a human's file.
   *
   * Two differences from `handleExport`. No `exportEmbedScene`: the scene JSON would
   * ride along inside the PNG for no benefit here, since the purpose is to look at
   * the picture and the diagram is already on disk. And the scale is capped, because
   * a render the agent reads is bounded by what an image can usefully convey — a
   * 20000px PNG is not more informative, just slower to make and heavier to read.
   */
  const renderToDataUrl = useCallback(async (elements, appState, scale = 1) => {
    let dims = { width: 0, height: 0, scale };
    const blob = await exportToBlob({
      elements,
      appState: { ...(appState ?? {}), exportBackground: true },
      files: EXPORT_FILES,
      mimeType: "image/png",
      exportPadding: 16,
      getDimensions: (width, height) => {
        const maxSide = Math.max(width, height) || 1;
        const limit = 4096;
        const applied = maxSide > limit ? limit / maxSide : scale;
        dims = {
          width: Math.max(1, Math.round(width * applied)),
          height: Math.max(1, Math.round(height * applied)),
          scale: applied,
        };
        return dims;
      },
    });
    const dataUrl = await blobToDataUrl(blob);
    return { dataUrl, width: dims.width, height: dims.height };
  }, []);

  /**
   * Wait until the canvas is safe to photograph.
   *
   * Two waits, both for real races. The API may not have arrived yet on a fresh card.
   * And a repaint the agent's own write triggered is still settling — `settleUntil` is
   * the same window the autosave uses to distinguish a reflow from an edit, so
   * reusing it here is what keeps a render from capturing a state that never existed
   * on screen.
   */
  const waitUntilRenderable = useCallback(async () => {
    for (let i = 0; i < 40 && !apiRef.current; i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    const remaining = settleUntil.current - Date.now();
    if (remaining > 0) await new Promise((r) => setTimeout(r, remaining + 60));
  }, []);

  /**
   * Pull the authoritative board and paint it. Used on conflict and on remote
   * writes.
   *
   * An unchanged revision means there is nothing new to paint, and painting
   * anyway would clobber whatever the user has in flight. That matters because
   * a rename touches the same storage record without moving `rev` — without this
   * guard, renaming a file from the panel would repaint the canvas from the last
   * save and silently drop the strokes drawn since.
   */
  const pullRemote = useCallback(
    async (reason, opts = {}) => {
      // Always the board on the canvas, never the requested one: pulling for a
      // board that is not loaded would paint content the autosave must not trust.
      const target = loadedBoardId.current;
      if (!target) return;
      try {
        const board = await loadBoard(target);
        if (!board) return;
        if (!opts.force && board.rev === myRev.current) return;
        myRev.current = board.rev;
        applyRemoteScene(board.scene);
        setCount(board.scene.elements.length);
        // Frame the board only when it is *arriving*: first open, or the user
        // switched to it. A `pulse`/agent repaint falls through untouched, so the
        // viewport stays where the reader left it.
        if (reason === "initial") fitSceneToContent(board.scene.elements);
        // The initial load is not an update, and saying it was is the one thing
        // this line must never do: it fires on *every* card open, so a banner
        // that lies there teaches the user to ignore the one time it is true.
        // The revision it used to print now lives on the row in the panel, where
        // it can be compared against the other boards instead of being read once
        // and forgotten.
        if (reason !== "initial") setRemoteRev({ rev: board.rev, by: board.updatedBy });
        setStatus(`r${board.rev} ${reason || "updated"}`);
        track("board:synced", { rev: board.rev, by: board.updatedBy, reason: reason || "updated" });
      } catch (err) {
        console.warn("[excalidraw] remote pull failed:", err);
        setStatus("sync failed");
      }
    },
    [applyRemoteScene, fitSceneToContent],
  );

  /**
   * The manual Sync button is gone; this is what took over its job.
   *
   * It had exactly two jobs the automatic paths did not cover, and both are
   * "this page is showing something that is no longer what is on disk":
   *
   *   - a *second* whiteboard window saved. Board content lives in files now,
   *     and the signal was only sent for the agent's writes, precisely so a page
   *     would not repaint itself mid-stroke (PLAN.md D7). That left two open
   *     windows silently diverging. The backend now signals every write, and
   *     this page is immune to its own signal because `pullRemote` returns early
   *     when the revision has not moved.
   *   - the card was hidden or restored from a snapshot — switched to another
   *     tab, or a window that had been sitting in the background long enough for
   *     the board to change underneath it.
   *
   * Both are "come back to this page" moments, which is when this runs. A button
   * asked the user to know that something had changed and to go looking for it;
   * this notices the return instead. The guard on the API matters: pulling before
   * Excalidraw has mounted would paint into nothing.
   */
  useEffect(() => {
    if (preview) return;
    let timer = 0;
    const onReturn = () => {
      if (document.visibilityState === "hidden") return;
      if (!apiRef.current) return;
      clearTimeout(timer);
      // Focus and visibility can both fire for one tab switch.
      timer = setTimeout(() => pullRemote("returned"), 150);
    };
    document.addEventListener("visibilitychange", onReturn);
    window.addEventListener("focus", onReturn);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onReturn);
      window.removeEventListener("focus", onReturn);
    };
  }, [preview, pullRemote]);

  /**
   * Export. This has to run here, in the page, and nowhere else: both export paths
   * need the browser. `exportToBlob` rasterises through a real `<canvas>`, which
   * does not exist in the app process, and `exportToSvg` builds a DOM node. The
   * file is handed to the backend as a data URL and written under the app's
   * dataDir, so the user gets a path they can open rather than a download prompt
   * inside an iframe that may block it.
   *
   * The two formats take genuinely different paths:
   *
   *   - PNG goes through `exportToBlob`, which always rasterises.
   *   - SVG goes through `exportToSvg`, which resolves to a detached SVG *element*,
   *     wrapped into a Blob via `outerHTML` — the same thing Excalidraw's own
   *     export dialog does with it.
   *
   * Asking `exportToBlob` for `image/svg+xml` does not fail; it hands back a PNG.
   * That shipped once: a `.svg` file whose bytes were byte-identical to the `.png`.
   * So the produced blob is now checked against the format before anything is
   * written.
   */
  const handleExport = useCallback(
    async (format) => {
      const editor = apiRef.current;
      if (!editor || exporting) return;
      setExporting(format);
      try {
        const { elements, appState } = editor.getSceneElements
          ? { elements: editor.getSceneElements(), appState: editor.getAppState() }
          : { elements: [], appState: {} };
        const live = elements.filter((e) => !e.isDeleted);
        if (!live.length) {
          setStatus("nothing to export");
          return;
        }

        // `exportAppState` adds `exportEmbedScene`, which is what makes the file
        // re-openable as elements instead of as a picture. Verified by inspecting
        // the bytes of an earlier export: without it, the PNG carried only
        // IHDR/IDAT/IEND and the SVG carried only the always-present
        // `svg-source:excalidraw` marker.
        const state = exportAppState(appState);

        const blob =
          format === "svg"
            ? await svgBlob(live, state)
            : await exportToBlob({
                elements: live,
                appState: state,
                // Required by `ExportOpts` even when there are no image elements.
                files: EXPORT_FILES,
                mimeType: "image/png",
                exportPadding: 16,
              });

        // Refuse to write a mislabelled file. A silent mismatch is how a PNG ended
        // up named `.svg` once, and a wrong file is worse than a failed export.
        const kind = await sniffBlob(blob);
        if (kind !== format) {
          setStatus(`export produced ${kind}, not ${format}`);
          track("board:export-mismatch", { format, produced: kind, bytes: blob.size });
          return;
        }

        const dataUrl = await blobToDataUrl(blob);
        const boardId = loadedBoardId.current || activeId;
        const result = await deliverExport({
          boardId,
          format,
          dataUrl,
          // Suggested filename in the save dialog, so the user sees a name they
          // recognise instead of an id.
          title: currentTitleRef.current || boardId,
        });

        // Each outcome gets its own message. "The user pressed cancel" and "the
        // write failed" are different events; collapsing them into one status is
        // how a real failure gets read as a user action.
        //
        // They go to the panel now, not to `setStatus`. `setStatus` only ever
        // reached a debug line painted over the canvas, so these four carefully
        // separated outcomes were written where nobody reads them — and the
        // export buttons have just moved to the panel, which makes the panel the
        // surface the user is looking at while one of these happens.
        const label = `导出 ${format.toUpperCase()}`;
        switch (result.outcome) {
          case "saved":
            setNotice({
              label,
              value: basename(result.path) || result.name || "",
              delta: result.overwritten ? "已覆盖保存" : "已保存",
              tone: "success",
            });
            track("board:exported", { format, via: "dialog", path: result.path, overwritten: result.overwritten });
            break;
          case "canceled":
            setNotice({ label, value: "已取消", delta: "", tone: "neutral" });
            track("board:export-canceled", { format });
            break;
          case "conflict":
            setNotice({ label, value: basename(result.path) || "目标已存在", delta: "未写入", tone: "warning" });
            track("board:export-conflict", { format, path: result.path, mayHaveWritten: result.mayHaveWritten });
            break;
          case "download":
            setNotice({ label, value: result.name || "", delta: "已交给浏览器下载", tone: "neutral" });
            track("board:exported", { format, via: "download", verified: false });
            break;
          case "folder":
            // Fallback path: no dialog available on this surface.
            setNotice({ label, value: basename(result.path) || result.name || "", delta: "已存到应用目录", tone: "success" });
            track("board:exported", {
              format,
              via: "app-folder",
              path: result.path,
              dialogError: result.dialogError,
            });
            break;
          default:
            setNotice({ label, value: "导出失败", delta: result.detail || "", tone: "danger" });
            track("board:export-error", { format, detail: result.detail });
        }
      } catch (err) {
        setNotice({ label: `导出 ${format.toUpperCase()}`, value: "导出失败", delta: String(err?.message || err).slice(0, 90), tone: "danger" });
        console.warn("[excalidraw] export failed:", err);
        track("board:export-error", { format, message: String(err?.message || err) });
      } finally {
        setExporting("");
      }
    },
    [activeId, exporting, setNotice],
  );

  const flush = useCallback(async () => {
    const draft = pendingScene.current;
    if (!draft) return;
    // The draft records which board it was captured from. If the canvas has moved
    // on since — a switch, or the board finishing its load — this content no
    // longer belongs to anything and must be dropped, not written somewhere.
    if (!draft.boardId || draft.boardId !== loadedBoardId.current) {
      pendingScene.current = null;
      track("board:draft-dropped", { from: draft.boardId ?? null, current: loadedBoardId.current ?? null });
      return;
    }
    const scene = { elements: draft.elements, appState: draft.appState };
    pendingScene.current = null;
    setStatus("saving");
    try {
      const { rev } = await saveBoardScene(scene, draft.boardId, "user", myRev.current);
      myRev.current = rev;
      setStatus(`saved r${rev}`);
      track("board:saved", { rev, boardId: draft.boardId, elements: scene.elements.length });
    } catch (err) {
      if (err?.status === 409) {
        // Somebody else moved first. Hold on to our draft and let the user
        // choose — silently dropping what they drew is not an option, and
        // silently overwriting the other writer is the bug that ate an agent's
        // diagram earlier today.
        setStatus("conflict");
        setConflictDraft({ ...scene, boardId: draft.boardId });
        track("board:conflict", { baseRev: myRev.current, mine: scene.elements.length });
      } else {
        setStatus("save failed");
        track("board:save-error", { message: String(err?.message || err) });
        console.warn("[excalidraw] save failed:", err);
      }
    }
  }, []);

  /** Conflict resolution: take the other writer's version. */
  const takeRemote = useCallback(async () => {
    setConflictDraft(null);
    await pullRemote("took remote");
  }, [pullRemote]);

  /** Conflict resolution: keep ours and overwrite, deliberately. */
  const takeLocal = useCallback(async () => {
    const draft = conflictDraft;
    setConflictDraft(null);
    if (!draft) return;
    // The canvas has moved to another board since this conflict was raised, so
    // there is nowhere safe to put these strokes: not here (they belong to the
    // other board) and not there (the other writer's version is now current).
    // Say so instead of dropping them in silence.
    if (draft.boardId && draft.boardId !== loadedBoardId.current) {
      setStatus("冲突草稿已失效（已切到别的画板）");
      track("board:conflict-abandoned", { boardId: draft.boardId, current: loadedBoardId.current });
      return;
    }
    const scene = { elements: draft.elements, appState: draft.appState };
    setStatus("saving");
    try {
      const { rev } = await saveBoardScene(scene, draft.boardId, "user", null);
      myRev.current = rev;
      setStatus(`saved r${rev}`);
      track("board:conflict-forced", { rev, elements: scene.elements.length });
    } catch (err) {
      setStatus("save failed");
      console.warn("[excalidraw] forced save failed:", err);
    }
  }, [conflictDraft]);

  const onChange = useCallback(
    (elements, appState) => {
      setCount(elements.length);
      // initializeScene is async and can settle after the first theme effect.
      // Recheck its final state on the next turn, after React has committed it.
      if (!preview && !appState?.isLoading) {
        const bg = appState?.viewBackgroundColor;
        const defaultBg = !bg || bg === DEFAULT_CANVAS_BACKGROUND || bg === LEGACY_DARK_BACKGROUND;
        if (appState?.theme !== theme || (defaultBg && bg !== DEFAULT_CANVAS_BACKGROUND)) {
          clearTimeout(themeCheckTimer.current);
          themeCheckTimer.current = setTimeout(() => reconcileTheme(), 0);
        }
      }
      if (preview) return; // a read-only preview never writes
      if (echoRef.current) return; // agent's scene coming back through onChange
      if (Date.now() < settleUntil.current) return; // post-load reflow, not an edit
      // Tag the draft with the board it came from, so a switch between capture
      // and flush can never reassign it. See `loadedBoardId`.
      if (!loadedBoardId.current) return; // canvas has no owner yet: not saveable
      pendingScene.current = { elements, appState, boardId: loadedBoardId.current };
      clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(flush, SAVE_DEBOUNCE_MS);
    },
    [flush, preview, reconcileTheme, theme],
  );

  /**
   * Load a specific board and paint it.
   *
   * Declared *before* the effects that reference it. `const` is not hoisted, and
   * a dependency array is evaluated during render — so an effect at the top of
   * the component listing a callback declared further down throws a temporal-dead
   * -zone ReferenceError mid-render. React then unmounts the whole tree and the
   * card is a blank white page. It is valid syntax, so the build says nothing.
   *
   * Takes the id as an argument rather than reading `activeId`, so a caller that
   * captured an earlier value still switches to the board it asked for.
   */
  const applyBoard = useCallback(
    async (next) => {
      if (!next) return;
      const token = ++loadToken.current;
      // Persist whatever the board being left has pending before walking away.
      // Safe because `flush` checks ownership: the draft is tagged with the board
      // that is still on the canvas, so it goes to its own file.
      await flush();
      try {
        const board = await loadBoard(next);
        // A newer switch started while this one was loading: abandon this result
        // rather than painting a board the user already left.
        if (token !== loadToken.current) {
          track("board:switch-superseded", { boardId: next });
          return;
        }
        if (!board) {
          // Ownership is NOT claimed here. A failed load leaves the previous
          // board on the canvas, and claiming the new id would let the next
          // autosave write that content into a board the user never opened.
          setStatus("no such board");
          return;
        }
        clearTimeout(saveTimer.current);
        pendingScene.current = null;
        setConflictDraft(null);
        // Claim the canvas only now that there is a scene to put on it.
        loadedBoardId.current = next;
        myRev.current = board.rev;
        setActiveId(next);
        applyRemoteScene(board.scene);
        setCount(board.scene.elements.length);
        // A switch is a new board, so it gets framed; see `fitSceneToContent` for
        // why this is not done on every repaint.
        fitSceneToContent(board.scene.elements);
        setStatus(`r${board.rev} switched`);
        track("board:switched", { boardId: next, rev: board.rev });
      } catch (err) {
        if (token !== loadToken.current) return;
        setStatus("switch failed");
        console.warn("[excalidraw] switch failed:", err);
      }
    },
    [applyRemoteScene, fitSceneToContent, flush],
  );

  const activeIdRef = useRef(activeId);
  activeIdRef.current = activeId;
  const currentTitleRef = useRef("");

  /**
   * Hand the keyboard back to the canvas.
   *
   * A dialog owns the focus while it is open and, on close, its input is
   * unmounted — so focus falls to `<body>`, where Excalidraw sees no key events
   * at all. The next thing a user does after "new board" is draw, and without
   * this the first stroke has to be preceded by a click on empty canvas.
   *
   * There is no API for it: `ExcalidrawImperativeAPI` in 0.18.1 exposes
   * `updateScene` / `setActiveTool` / `scrollToContent` and no `focus`, while the
   * App class has `focusContainer()` but does not publish it. The container is
   * the element that method focuses — `.excalidraw.excalidraw-container` with
   * `tabIndex: 0`, verified in the shipped bundle, not inferred from a class
   * name. Every call is optional-chained, so a rename upstream degrades to
   * "no focus" rather than a thrown TypeError.
   */
  const focusCanvas = useCallback(() => {
    const canvas = document.querySelector(".excalidraw.excalidraw-container");
    if (canvas && typeof canvas.focus === "function") canvas.focus();
  }, []);

  /** Switch boards from the panel: remember the choice, then paint it. */
  const switchTo = useCallback(
    async (next) => {
      if (!next || next === activeIdRef.current) return;
      await switchBoard(next);
      await applyBoard(next);
    },
    [applyBoard],
  );

  useEffect(() => {
    connectHost();
    return onHostReady(setHost);
  }, []);

  /**
   * Follow the host's theme for as long as the card is open.
   *
   * `subscribe` fires immediately with the current value, so this both adopts the
   * theme the card opened under and picks up every change after it. Without the
   * immediate call the first change would arrive with nothing to compare against
   * and the canvas would sit in the old theme until the user toggled twice.
   */
  useEffect(() => {
    if (preview) return;
    const apply = (snapshot) => {
      // Attribute first, measure second. Reversing these measures the previous
      // theme: the host swaps the sheet and notifies on the same tick, so a
      // measure-then-set order reads the old stylesheet.
      syncHostThemeAttribute(snapshot?.theme, document);
      setTheme(resolveAppearance(snapshot, document));
    };
    try {
      apply(hana.theme?.getSnapshot?.());
      const off = hana.theme?.subscribe?.(apply);
      // One more pass on the next frame. The host's stylesheet is injected
      // asynchronously (`fetch`, then a `<style>` append to `<head>`), so at
      // subscribe time the sheet for the new theme may not be in the document
      // yet, and the measurement answers with the old theme's colours.
      const raf = requestAnimationFrame(apply);
      return () => {
        cancelAnimationFrame(raf);
        off?.();
      };
    } catch (err) {
      // No theme surface here: keep the seeded value and the fallback colours.
      // Loud, for the same reason as the other catch.
      console.warn("[excalidraw] host theme subscribe failed, staying on the seeded theme:", err);
    }
  }, [preview]);

  // A remembered choice wins over the default, so reopening the card lands on
  // the scene the user was last looking at. A preview card overrides both: it
  // belongs to the board that was shared.
  //
  // `initialData` already resolved and painted this board, so repaint only when
  // the answer differs — otherwise every open would repaint a scene that is
  // already on the canvas.
  useEffect(() => {
    if (preview) return;
    readActiveBoard().then((id) => {
      if (id && id !== loadedBoardId.current) applyBoard(id);
    });
  }, [preview, applyBoard]);

  useEffect(() => {
    initialData
      .then((scene) => {
        setCount(scene?.elements?.length ?? 0);
        setStatus("saved");
        const painted = loadedBoardId.current;
        if (!painted) {
          settleUntil.current = Date.now() + 3000;
          return;
        }
        // Paint from a read taken *now*, rather than adopting the revision from
        // one read while the canvas still holds another's scene.
        //
        // That mismatch is exactly how an empty canvas legally overwrote 36 real
        // elements: `initialData` resolved before the store had the scene, the
        // canvas stayed empty, a later read handed over a valid current revision,
        // and the next autosave was accepted. Content and revision now come from
        // the same read; if the board is missing, `myRev` stays 0 and a save is
        // refused as a conflict instead of silently erasing anything.
        // A preview card is a board arriving too, and it has no autosave and no
        // switch: it paints once. It used to inherit the stored viewport, so
        // dropping that would park a shared diagram at its top-left corner. Fit it
        // here instead — same rule, same helper.
        if (preview) {
          fitSceneToContent(scene?.elements);
          return;
        }
        return pullRemote("initial", { force: true }).finally(() => {
          // give Excalidraw a moment to reflow against the loaded webfonts
          settleUntil.current = Date.now() + 3000;
        });
      })
      .catch(() => setStatus("saved"));
  }, [initialData, pullRemote, preview, fitSceneToContent]);

  // Someone else wrote a board — the agent through its tool, or another
  // window. The scene lives in a file now, so the signal is the `boardpulse` key
  // the backend writes after an agent write; a page pulls and repaints only if
  // its own board's revision actually moved.
  useEffect(() => {
    if (!host) return;
    return subscribeBoardPulse((pulse) => {
      // Skip our own write without pulling. The signal carries the revision it
      // belongs to, so the comparison costs one small storage read — while
      // `pullRemote` would fetch the entire scene only to discover the revision
      // has not moved and return. That trade is worth it on every autosave, which
      // is to say: constantly.
      if (pulse && pulse.boardId === loadedBoardId.current && pulse.rev === myRev.current) {
        return;
      }
      pullRemote("pulse");
    });
  }, [host, pullRemote]);

  /**
   * File operations live in the panel now.
   *
   * They used to live here, behind a dialog, because the panel vocabulary has no
   * text field and a rename with nowhere to type a name is not a rename. The
   * panel is its own document as of 0.12.0 (`functionPanel.route`), so it has a
   * text field, and the three file operations moved there with it — the panel
   * already holds the list, so it can name a board the canvas is not showing
   * without the card ever loading it. What stayed here is what genuinely needs
   * the Excalidraw instance: switching boards, and exporting.
   */
  const handleCommand = useCallback(
    async (command) => {
      const kind = command?.kind;
      if (kind === "switch") {
        const id = command.boardId;
        if (typeof id !== "string" || !id) return;
        // Same as a row click, including handing the canvas the keyboard back:
        // the user is about to draw on whatever this just swapped in.
        await switchTo(id);
        return;
      }
      if (kind === "export") {
        if (command.format !== "png" && command.format !== "svg") return;
        await handleExport(command.format);
      }
    },
    [switchTo, handleExport],
  );

  /**
   * Take commands from the panel.
   *
   * `sinceAt` is the moment this effect is set up, not zero. The panel writes a
   * command and the card may mount a second later — or the panel may remount
   * while the card stays put — and replaying the last one would re-run the
   * export the user just watched finish. A command is a thing that happened, not
   * a thing that is true, so it is read once and then left behind.
   */
  useEffect(() => {
    if (preview) return;
    return subscribeBoardCommand(handleCommand, Date.now());
  }, [preview, handleCommand]);

  /**
   * Mermaid conversions requested by the agent.
   *
   * The tool cannot convert: Mermaid lays out a graph by measuring text in a real
   * document, so it leaves a request and this page answers it (see lib/mermaid.js).
   *
   * Deliberately not folded into `handleCommand`. That channel is the panel's, and
   * its `sinceAt = Date.now()` guard exists to drop commands issued before the card
   * mounted — the opposite of what a pending request needs, since by far the common
   * case is a request that is already waiting when the page loads.
   *
   * The probe gets its own key. `probePreview` defaults to `ui:previewProbe`, which
   * holds the hand-tool measurement; writing here without a separate key would
   * silently clobber it — the same collision this code already suffered once when
   * the hand-tool and chrome probes shared a key.
   */
  useEffect(() => {
    if (preview) return;
    return installMermaidBridge({
      enabled: true,
      storage: hostStorage(hana),
      converters: { parse: parseMermaidToExcalidraw, toElements: convertToExcalidrawElements },
      load: loadBoard,
      save: saveBoardScene,
      // Land any edits still inside the debounce window before the conversion
      // commits, so the user does not get a conflict banner for work they had
      // already finished.
      beforeConvert: flush,
      onCommitted: async (outcome) => {
        // Paint what was just written instead of waiting for a broadcast this page
        // itself caused.
        //
        // `settleUntil` is pushed forward **before** the repaint, and for exactly
        // the reason the initial load uses it: the new text elements make
        // Excalidraw re-measure once the webfonts land, which fires `onChange` long
        // after the 400 ms echo window has closed. The debounced autosave then
        // writes the agent's own diagram back as a *user* edit — a revision bumped
        // for no change, attributed to the wrong author. Observed on the first live
        // run: the commit landed at rev 355, then the page saved again as 356.
        settleUntil.current = Date.now() + 3000;

        // A diagram usually lands in a *new* board now, which is not the one on the
        // canvas. Pulling would repaint the board the user is already looking at, so
        // the drawing they asked for would appear to have gone nowhere. Switching
        // also records the choice, so reopening the card returns to it.
        if (outcome.boardId && outcome.boardId !== loadedBoardId.current) {
          await switchTo(outcome.boardId);
        } else {
          await pullRemote("mermaid", { force: true });
        }
        setNotice(`已用 Mermaid 画入 ${outcome.count} 个图元`);
      },
      track,
      probe: (payload) => probePreview(payload, "ui:mermaidProbe"),
    });
  }, [preview, flush, pullRemote, switchTo]);

  // `loadBoard` and `saveBoardScene` are stable module-level functions, so the
  // effect above does not need them as dependencies.

  /**
   * Answer "what does this board look like?" from the canvas on screen.
   *
   * Used when the requested board *is* the one loaded here, which is the only case
   * where this page has an advantage: the canvas includes strokes the user has made
   * since the last save. Anything else comes from disk (below), because guessing from
   * a canvas that shows a different board would attach the wrong picture to the name.
   */
  const resolveLiveScene = useCallback(
    (want) => {
      const held = loadedBoardId.current;
      if (want && want !== held) return { ok: false, reason: "not-open" };
      const { elements, appState } = snapshotCanvas();
      return { ok: true, boardId: held, elements, appState, source: "live" };
    },
    [snapshotCanvas],
  );

  /**
   * Answer the same question from the saved file, for any board.
   *
   * This is what makes an in-chat preview card a full renderer. `exportToBlob` renders
   * whatever elements it is handed into its own offscreen canvas, so a preview does not
   * need to be showing the requested board — it only needs to fetch it. That closes the
   * gap the board page leaves: the agent can `board_share` a card and then render, with
   * nobody switching anything by hand.
   *
   * It is honest about being a different source: the result carries `source: "disk"`, so
   * a picture taken from the file is never passed off as the live canvas.
   */
  const resolveStoredScene = useCallback(async (want) => {
    const id = want || loadedBoardId.current;
    if (!id) return { ok: false, reason: "missing", error: "没有指定要渲染哪一块画板。" };
    const board = await loadBoard(id);
    if (!board) return { ok: false, reason: "missing", error: `画板「${id}」不存在。` };
    const scene = board.scene ?? {};
    return {
      ok: true,
      boardId: id,
      elements: scene.elements ?? [],
      appState: scene.appState ?? {},
      source: "disk",
    };
  }, []);

  /**
   * A preview rasterizes elements it fetched, not a canvas it painted, so "the repaint
   * has settled" means nothing here. Fonts do: the text is rendered by the export, and
   * a font still loading would be drawn in a fallback face.
   */
  const waitForExportFonts = useCallback(async () => {
    try {
      await document.fonts?.ready;
    } catch {
      /* best-effort: a missing FontFaceSet must not block the render */
    }
  }, []);

  /**
   * Render requests from the agent — "let me look at what I drew".
   *
   * Same handshake shape as Mermaid, for the same reason: rasterizing needs a live
   * document, and the backend has none (`lib/render.js`). An in-chat preview answers
   * it too, reading the board from disk; two open pages arbitrate by claim
   * (`src/renderBridge.js`).
   */
  useEffect(() => {
    return installRenderBridge({
      enabled: true,
      storage: hostStorage(hana),
      heldBoardId: () => loadedBoardId.current,
      resolveScene: preview ? resolveStoredScene : resolveLiveScene,
      exportPng: renderToDataUrl,
      deliver: ({ boardId, format, dataUrl }) => uploadExport(boardId, { format, dataUrl }),
      waitUntilReady: preview ? waitForExportFonts : waitUntilRenderable,
      track,
    });
  }, [
    preview,
    resolveLiveScene,
    resolveStoredScene,
    renderToDataUrl,
    waitUntilRenderable,
    waitForExportFonts,
  ]);

  /**
   * The remote-update banner takes itself back.
   *
   * The conflict banner deliberately does not: it is asking a question, and a
   * question that vanishes is a question with no answer. This one is only
   * reporting, so a timer is the honest treatment.
   */
  useEffect(() => {
    if (!remoteRev) return;
    const timer = setTimeout(() => setRemoteRev(null), REMOTE_BANNER_MS);
    return () => clearTimeout(timer);
  }, [remoteRev]);

  /**
   * The notice takes itself back.
   *
   * A panel repushed every 4s with the same line in it would read as a permanent
   * status bar; a line that vanishes on its own reads as something that happened.
   * Cleared by effect rather than by a timer inside `setNotice` so a burst of
   * outcomes restarts one window instead of stacking several.
   */
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), NOTICE_MS);
    return () => clearTimeout(timer);
  }, [notice]);

  /**
   * Tell the panel about the export.
   *
   * The notice and the "导出中…" state used to be pushed by the card and drawn
   * by the host's `status` primitive. The panel is a separate document now, so
   * the same two facts go out as one storage write — one key, because they
   * change together and a panel reconciling two clocks can briefly disagree
   * with itself about whether an export finished.
   */
  useEffect(() => {
    if (preview) return;
    void publishBoardStatus({ exporting, notice });
  }, [preview, exporting, notice]);

  // The host titlebar floats over the card's top strip, which is where
  // Excalidraw keeps its own library / palette / menu controls. Declare those
  // rectangles so the host yields the space instead of eating the clicks.
  useEffect(() => {
    if (!host) return;
    let frame = 0;
    const remeasure = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => syncInteractiveRegions());
    };
    remeasure();
    const observer = new ResizeObserver(remeasure);
    if (shellRef.current) observer.observe(shellRef.current);
    window.addEventListener("resize", remeasure);
    const timer = setInterval(remeasure, 2000);
    return () => {
      clearInterval(timer);
      clearTimeout(saveTimer.current);
      clearTimeout(echoTimer.current);
      clearTimeout(themeCheckTimer.current);
      observer.disconnect();
      window.removeEventListener("resize", remeasure);
      cancelAnimationFrame(frame);
    };
  }, [host, api]);

  useEffect(() => {
    if (!preview || !api) return;
    // Late enough that fonts have settled and the layout has stopped changing.
    const timer = setTimeout(() => {
      // Its own key: this measurement lands later than the hand-tool one, and a
      // shared key would have had them overwrite each other.
      probePreview({ outcome: "chrome", chrome: measureChrome() }, "ui:chromeProbe");
    }, 1800);
    return () => clearTimeout(timer);
  }, [preview, api]);

  useEffect(() => {
    if (!api) return;
    // One record that tells the agent everything it cannot see from outside:
    // whether the host handshake landed, whether the interactive regions were
    // accepted, and how big the stored scene is.
    const timer = setTimeout(() => {
      track("board:ready", {
        api: true,
        host,
        preview,
        elements: count,
        regionsApplied: regionReport.applied,
        regionsRefused: regionReport.refused,
        regionCount: regionReport.last ? regionReport.last.length : 0,
      });
    }, 800);
    return () => clearTimeout(timer);
  }, [api, host, preview, count]);

  /**
   * Zoom controls for the in-chat preview.
   *
   * These are view operations, so read-only does not forbid them: nothing touches
   * the elements, nothing is saved (a preview never writes), and the shared scene
   * is unaffected. They exist because the preview is a narrow column — Excalidraw
   * puts a full toolbar there that the reader did not ask for, and at unzoomed
   * scale a whole flowchart does not fit.
   */
  const onScrollChange = useCallback((_scrollX, _scrollY, next) => {
    const value = Number.isFinite(next?.value) && next.value > 0 ? next.value : 1;
    setZoom((prev) => (Math.abs(prev - value) < 1e-6 ? prev : value));
  }, []);

  const applyZoom = useCallback((next) => {
    const editor = apiRef.current;
    if (!editor) return;
    // `updateScene` needs the current appState to compute the compensating scroll;
    // guessing it would anchor the zoom at the corner instead of the centre.
    editor.updateScene({ appState: zoomPatch(editor.getAppState(), next) });
    setZoom(Number.isFinite(next) ? next : 1);
  }, []);

  const zoomIn = useCallback(() => {
    const editor = apiRef.current;
    if (!editor) return;
    applyZoom(steppedZoom(editor.getAppState()?.zoom?.value, 1));
  }, [applyZoom]);

  const zoomOut = useCallback(() => {
    const editor = apiRef.current;
    if (!editor) return;
    applyZoom(steppedZoom(editor.getAppState()?.zoom?.value, -1));
  }, [applyZoom]);

  const zoomReset = useCallback(() => applyZoom(1), [applyZoom]);

  /**
   * Fit the drawing to the card.
   *
   * `scrollToContent` is Excalidraw's own fit routine, so it accounts for element
   * bounds properly; hand-rolling the arithmetic here would be a worse copy of it.
   * An empty scene has nothing to fit, so the call is skipped — the alternative is
   * Excalidraw zooming to a degenerate box.
   */
  const zoomFit = useCallback(() => {
    const editor = apiRef.current;
    if (!editor) return;
    const elements = (editor.getSceneElements?.() ?? []).filter((e) => !e.isDeleted);
    if (!elements.length) return;
    editor.scrollToContent(elements, { fitToContent: true, animate: true });
  }, []);

  // `data-preview` lets CSS strip Excalidraw's editor chrome in the read-only
  // preview only. A data attribute rather than a class, so it cannot collide with
  // a class Excalidraw sets on this same node.
  return (
    <div
      className="board-shell"
      ref={shellRef}
      data-api-ready={api ? "yes" : "no"}
      data-preview={preview ? "true" : undefined}
      data-theme={theme}
    >
      <Excalidraw
        theme={theme}
        excalidrawAPI={onApi}
        onChange={onChange}
        initialData={initialData}
        /* the card page has no outbound network, and embeddable/iframe elements
           are the one element type that loads remote URLs by design */
        validateEmbeddable={[]}
        aiEnabled={false}
        /* Excalidraw ships its own locale bundles; zh-CN is present in the build */
        langCode="zh-CN"
        /* Excalidraw listens on window by default; inside a card iframe the
           canvas is often not the focused element, so keep it explicit */
        handleKeyboardGlobally
        /* An in-chat preview must not accept edits: the user drew nothing here,
           and a card that looks editable but silently discards input is worse
           than one that is visibly read-only. */
        viewModeEnabled={preview}
        zenModeEnabled={false}
        /* Keeps the zoom readout honest: pinch/scroll zooming by the user arrives
           by the same route as our own button presses. */
        onScrollChange={onScrollChange}
        UIOptions={{
          canvasActions: {
            export: false,
            saveAsImage: false,
            loadScene: false,
            saveToActiveFile: false,
          },
        }}
      />
      {preview && (
        <div className="board-zoom" role="group" aria-label="缩放">
          <button
            type="button"
            className="board-zoom__btn"
            onClick={zoomOut}
            disabled={!api || zoom <= MIN_ZOOM}
            title="缩小"
            aria-label="缩小"
          >
            −
          </button>
          <button
            type="button"
            className="board-zoom__value"
            onClick={zoomReset}
            disabled={!api}
            title="恢复到 100%"
          >
            {zoomPercent(zoom)}
          </button>
          <button
            type="button"
            className="board-zoom__btn"
            onClick={zoomIn}
            disabled={!api || zoom >= MAX_ZOOM}
            title="放大"
            aria-label="放大"
          >
            +
          </button>
          <span className="board-zoom__divider" aria-hidden="true" />
          <button
            type="button"
            className="board-zoom__btn board-zoom__btn--wide"
            onClick={zoomFit}
            disabled={!api}
            title="缩放到适合内容"
          >
            适应
          </button>
        </div>
      )}
      {!preview && conflictDraft && (
        <div className="board-banner board-banner--warn" role="alert">
          <span>画板在别处被修改过，你这笔还没保存。</span>
          <button type="button" className="board-banner__btn" onClick={takeRemote}>
            用对方的
          </button>
          <button type="button" className="board-banner__btn" onClick={takeLocal}>
            用我的（覆盖）
          </button>
        </div>
      )}
      {!preview && remoteRev && !conflictDraft && (
        <div className="board-banner" role="status">
          {remoteRev.by === "agent" ? "Agent 刚改了这块画板" : "这块画板刚在别处更新"}
        </div>
      )}
    </div>
  );
}

/** Last path segment, for either separator: what the user sees as the filename. */
function basename(filePath) {
  if (typeof filePath !== "string" || !filePath) return "";
  const parts = filePath.split(/[\\/]/);
  return parts[parts.length - 1] || "";
}

/**
 * Measure whether the editor chrome is actually hidden.
 *
 * `describe_dom` cannot answer this. It is a structural outline, and its filtering
 * looks at each element's own `display` — so the descendants of a `display: none`
 * container are still listed, and a hidden toolbar reads as present. Two readings
 * of the same DOM contradicted each other because of exactly that.
 *
 * So the page measures itself. For each container: does it exist, what is its
 * computed `display`, and does it produce boxes (`offsetParent`/rect). Reported
 * through storage, where it can be read off disk.
 */
function measureChrome() {
  const selectors = [
    ".App-menu_top",
    ".shapes-section",
    ".App-toolbar-container",
    ".mobile-misc-tools-container",
    ".layer-ui__wrapper__top-right",
    ".sidebar-trigger",
  ];
  const out = {};
  for (const sel of selectors) {
    const el = document.querySelector(`.board-shell ${sel}`);
    if (!el) {
      out[sel] = "absent";
      continue;
    }
    const display = getComputedStyle(el).display;
    const rect = el.getBoundingClientRect();
    // `display: none` is the rule we set; a zero-area box is the corroborating
    // signal, since it means the element takes no space even if display differs.
    out[sel] = display === "none" || rect.width === 0 || rect.height === 0
      ? `hidden(${display})`
      : `visible(${display},${Math.round(rect.width)}x${Math.round(rect.height)})`;
  }
  return out;
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error || new Error("blob read failed"));
    reader.readAsDataURL(blob);
  });
}

/**
 * Real vector SVG.
 *
 * `exportToSvg` resolves to a detached SVG element, not a Blob, so it is wrapped
 * via `outerHTML` — exactly how Excalidraw's own export dialog turns it into a
 * downloadable file. `exportToBlob` cannot do this job: it renders through a
 * canvas and will cheerfully return a PNG when asked for `image/svg+xml`.
 */
async function svgBlob(elements, appState) {
  const svg = await exportToSvg({
    elements,
    appState,
    // Required by `ExportOpts` even when there are no image elements.
    files: EXPORT_FILES,
    exportPadding: 16,
  });
  const markup = svg?.outerHTML;
  if (typeof markup !== "string" || !markup.includes("<svg")) {
    throw new Error("exportToSvg did not return an SVG element");
  }
  return new Blob([markup], { type: "image/svg+xml" });
}

/**
 * What a blob actually is, decided by its bytes rather than by its label.
 *
 * Every one of these is a real signature: PNG's 8-byte magic, and SVG's first
 * non-whitespace character being `<` (an XML declaration or the root element).
 * Anything unrecognised reports `unknown` rather than being trusted.
 */
async function sniffBlob(blob) {
  const head = new Uint8Array(await blob.slice(0, 64).arrayBuffer());
  const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (PNG_MAGIC.every((b, i) => head[i] === b)) return "png";
  const text = new TextDecoder().decode(head).replace(/^\uFEFF/, "").trimStart();
  if (text.startsWith("<")) return "svg";
  return "unknown";
}
