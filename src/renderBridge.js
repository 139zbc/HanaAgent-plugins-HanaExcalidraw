import {
  RENDER_REQUEST_KEY,
  RENDER_RESULT_KEY,
  DEFAULT_RENDER_TIMEOUT_MS,
} from "../lib/render.js";

/**
 * The page half of the render handshake.
 *
 * The agent cannot rasterize its own drawing: `exportToBlob` needs a `<canvas>`, and
 * the Excalidraw bundle cannot even be imported outside a browser (see lib/render.js).
 * So "look at your work" is a request some open page answers.
 *
 * **Any page with the bundle loaded can answer, for any board.** That is the key
 * fact this module is built on, and it is easy to miss: `exportToBlob` takes
 * `elements` as an argument and renders them into its own offscreen canvas. It does
 * not read the canvas on screen, so the page's own contents are irrelevant to what it
 * can produce. The page only needs the board's elements and somewhere to put a PNG.
 *
 * That gives two honest sources for the same question, and the result says which was
 * used rather than pretending they are the same thing:
 *
 *   - **live** — the board currently on this page's canvas. Includes strokes the user
 *     has made since the last save. Only available here, so the board page uses it.
 *   - **disk** — the saved board, read through the backend route. Slightly behind a
 *     board that is being edited, but always available, for any board.
 *
 * Two pages can hold the bundle at once (the board page and an in-chat preview), so
 * `installRenderBridge` also arbitrates: a claim per token decides who rasterizes.
 * See the note on `CLAIM_KEY`.
 *
 * The split mirrors `mermaidBridge.js`: `runRender` is the logic (injectable, no
 * browser), `installRenderBridge` is the wiring.
 */

/** Keeps one request from rendering twice when the page remounts. */
const HANDLED_KEY = "ui:renderHandled";

/**
 * Which page is rasterizing which token.
 *
 * Two pages, one request. Storage has no compare-and-swap, so the claim is
 * write-then-re-read: the last writer wins and the other sees a foreign owner and
 * steps aside before doing any work.
 *
 * A lost race is harmless by construction, which is why a plain re-read is enough
 * instead of a lock. Any page that claims can serve the requested board (that is the
 * only precondition for claiming, and a board that cannot be read becomes a reported
 * `missing`, not a corruption), so two winners would write two correct pictures of the
 * same board — wasteful, not wrong. The claim exists to avoid the waste, not to
 * enforce correctness.
 */
const CLAIM_KEY = "ui:renderClaim";

/**
 * How old a request may be and still be worth answering.
 *
 * A request older than the tool's own timeout has nobody waiting for it: the tool
 * already gave up (and, since 0.17.1, deleted the key on the way out). Whatever is
 * left over is an orphan, and the likeliest way to make one is a host restart in the
 * middle of the call, which is exactly how this was found (开发记录 R74): a 17:24
 * request was replayed by the page at 17:28 and rendered a board nobody had asked
 * about for four minutes.
 */
const MAX_REQUEST_AGE_MS = DEFAULT_RENDER_TIMEOUT_MS;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Produce the render, against injected collaborators.
 *
 * `resolveScene(boardId)` is the page's answer to "can you give me this board?" — it
 * returns `{ ok: true, boardId, elements, appState, source }` or
 * `{ ok: false, reason: "missing", error }`. Keeping the decision out here means the
 * board page (live canvas) and a preview card (disk) differ only in that one function.
 */
export async function runRender({ boardId = null, scale = 1, ctx }) {
  const { heldBoardId, resolveScene, exportPng, deliver } = ctx;
  if (typeof resolveScene !== "function" || typeof exportPng !== "function" || typeof deliver !== "function") {
    throw new Error("runRender needs `resolveScene`, `exportPng` and `deliver`");
  }

  const held = heldBoardId?.() ?? null;
  const wanted = boardId || held;
  if (!wanted) {
    return { ok: false, reason: "no-board", error: "页面没有打开任何画板，也没说清要渲染哪一块。" };
  }

  let resolved;
  try {
    resolved = await resolveScene(wanted);
  } catch (err) {
    return {
      ok: false,
      boardId: wanted,
      reason: "read-failed",
      error: String(err?.message || err).slice(0, 300),
    };
  }
  if (!resolved?.ok) {
    return {
      ok: false,
      boardId: wanted,
      reason: resolved?.reason ?? "missing",
      error: resolved?.error ?? `无法读取画板「${wanted}」。`,
    };
  }

  const live = (Array.isArray(resolved.elements) ? resolved.elements : []).filter((e) => e && !e.isDeleted);
  const board = resolved.boardId ?? wanted;
  if (!live.length) {
    return { ok: false, boardId: board, reason: "empty", error: `「${board}」是空的，没有可渲染的内容。` };
  }

  let produced;
  try {
    produced = await exportPng(live, resolved.appState ?? {}, scale);
  } catch (err) {
    return { ok: false, boardId: board, reason: "export-failed", error: String(err?.message || err).slice(0, 300) };
  }
  const dataUrl = typeof produced === "string" ? produced : produced?.dataUrl;
  if (!dataUrl || !String(dataUrl).startsWith("data:")) {
    return { ok: false, boardId: board, reason: "export-failed", error: "导出没有产出图片数据。" };
  }

  let delivered;
  try {
    delivered = await deliver({ boardId: board, format: "png", dataUrl });
  } catch (err) {
    return { ok: false, boardId: board, reason: "save-failed", error: String(err?.message || err).slice(0, 300) };
  }
  if (!delivered?.ok || !delivered.file) {
    return { ok: false, boardId: board, reason: "save-failed", error: delivered?.error ?? "写入文件失败。" };
  }

  return {
    ok: true,
    boardId: board,
    source: resolved.source ?? "live",
    file: delivered.file,
    bytes: delivered.bytes ?? null,
    width: produced?.width ?? null,
    height: produced?.height ?? null,
  };
}

/**
 * Answer render requests while this page is mounted.
 *
 * `storage` must be the *adapting* one (`hostStorage`), because the host answers
 * reads with a `{ key, value }` wrapper: reading `request?.token` off it is
 * `undefined` every time, and the bridge then does nothing, silently, forever
 * (开发记录 R57).
 */
export function installRenderBridge({
  enabled,
  storage,
  heldBoardId,
  resolveScene,
  exportPng,
  deliver,
  waitUntilReady,
  track,
  log = console,
}) {
  if (!enabled) return () => {};

  let disposed = false;
  // Identity for the claim below, scoped to this installation rather than the module.
  // Two bridges in one process (as the tests have, and as a mis-mount briefly would)
  // must be two competitors, not one identity claiming on its own behalf twice.
  const pageId = `p${Math.random().toString(36).slice(2, 10)}`;

  const handle = async () => {
    if (disposed) return;
    let request = null;
    try {
      request = await storage.get(RENDER_REQUEST_KEY);
    } catch (err) {
      log.warn("[excalidraw] render: could not read request:", err?.message || err);
      return;
    }
    if (!request?.token) return;

    // An orphan from a call that was cut short — most likely a host restart. Age is
    // judged only when the tool actually recorded one; a request without a usable
    // `at` cannot be proven stale, so it is served rather than silently dropped.
    const age = Date.now() - Number(request.at);
    if (Number.isFinite(age) && age > MAX_REQUEST_AGE_MS) {
      log.warn(
        `[excalidraw] render: ignoring a ${Math.round(age / 1000)}s-old request (no one can still be waiting)`,
      );
      return;
    }

    // Already done here: a remount must not render it a second time and overwrite the
    // result the tool is waiting on.
    let handled = null;
    try {
      handled = await storage.get(HANDLED_KEY);
    } catch {
      /* nothing processed yet */
    }
    if (handled?.token === request.token) return;
    await storage.set(HANDLED_KEY, { token: request.token, at: Date.now() });

    // Two pages can answer; let one of them do it. See `CLAIM_KEY`.
    await storage.set(CLAIM_KEY, { token: request.token, by: pageId, at: Date.now() });
    await delay(60 + Math.floor(Math.random() * 90));
    const claim = await storage.get(CLAIM_KEY).catch(() => null);
    if (claim?.token === request.token && claim.by !== pageId) return;

    let outcome;
    try {
      // A repaint the agent's own write triggered is still settling, and capturing
      // mid-repaint would photograph a state that never existed for the user. (For a
      // disk-sourced render this only waits on fonts, which is cheap.)
      await waitUntilReady?.();
      outcome = await runRender({
        boardId: request.boardId ?? null,
        scale: request.scale ?? 1,
        ctx: { heldBoardId, resolveScene, exportPng, deliver },
      });
    } catch (err) {
      outcome = { ok: false, reason: "page-error", error: String(err?.message || err).slice(0, 300) };
    }

    try {
      await storage.set(RENDER_RESULT_KEY, { token: request.token, at: Date.now(), ...outcome });
    } catch (err) {
      log.warn("[excalidraw] render: could not write result:", err?.message || err);
    }
    track?.(outcome.ok ? "board:rendered" : "board:render-failed", {
      boardId: outcome.boardId ?? null,
      source: outcome.source ?? null,
      reason: outcome.reason,
      bytes: outcome.bytes ?? null,
    });
  };

  const off = storage.onChanged((keys) => {
    if (Array.isArray(keys) && keys.includes(RENDER_REQUEST_KEY)) handle();
  });
  // The common case is a request already waiting when the page mounts.
  handle();

  return () => {
    disposed = true;
    off?.();
  };
}
