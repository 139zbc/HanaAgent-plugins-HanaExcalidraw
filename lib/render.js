/**
 * "Look at your own drawing", requested by the agent but rendered by the page.
 *
 * The backend cannot rasterize: `exportToBlob` creates a `<canvas>`, and
 * `@excalidraw/excalidraw` cannot even be *imported* outside a browser — its prod
 * bundle evaluates `"netscape" in window` at module scope, so it throws before any
 * function is called. Measured, not assumed: a Node bundle of it fails with
 * `ReferenceError: window is not defined`, and there is no configuration that
 * changes that (PLAN.md §2.1, and the probe recorded in R6's note).
 *
 * So the picture has to come from the open card page. This module is the request
 * half of the same handshake the Mermaid conversion uses — a request in storage, an
 * answer in storage, correlated by token:
 *
 *   1. the tool writes `ui:renderRequest` and waits;
 *   2. the page sees it, rasterizes the canvas it is showing, hands the bytes to the
 *      backend's export route, and records the resulting path in `ui:renderResult`;
 *   3. the tool reports the path, and the agent reads the file like any other.
 *
 * `board_check` covers everything that can be known from the elements alone; this
 * exists for what only a picture can answer — crowding, clipped text, whether the
 * layout actually reads.
 *
 * Note the asymmetry with the page, same as in mermaid.js: **reads here are bare
 * values** (the server-side `storage.get` is an in-process call) while the card-side
 * one answers the host's `{ key, value }` wrapper. So `result.token` below is
 * correct as written; the page needs `unwrapStored`.
 */

export const RENDER_REQUEST_KEY = "ui:renderRequest";
export const RENDER_RESULT_KEY = "ui:renderResult";

/**
 * Longer than the Mermaid timeout on purpose. A conversion is arithmetic plus a
 * layout pass; this one also rasterizes a scene that may be tens of thousands of
 * pixels tall and then writes the file, so it is the slower of the two by a lot.
 *
 * It is also strictly shorter than the ceiling imposed from outside: the host gives a
 * tool call 30 s before it gives up with `RPC callback.tools.execute timed out`.
 * A budget at or above that ceiling is worse than useless — the caller never sees
 * this module's own answer, only the generic RPC failure, so "the card is not open"
 * arrives as an unexplained timeout. The whole point of waiting here is to be the
 * one who reports the reason; that only works if we give up first. (Measured: the
 * first live `board_render` with a 30 s budget produced exactly that RPC timeout,
 * and the polite message was never delivered.)
 */
export const DEFAULT_RENDER_TIMEOUT_MS = 12000;

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Ask the page to render the board and wait for the file path.
 *
 * Returns a discriminated result, like `requestConversion`: "the card is not open",
 * "that board is not the one on screen", and "the page never answered" are three
 * different situations and the caller should be able to say which happened.
 */
export async function requestRender(
  sdk,
  { boardId = null, scale = 1, timeoutMs = DEFAULT_RENDER_TIMEOUT_MS, pollMs = 300 } = {},
  deps = {},
) {
  const now = deps.now ?? (() => Date.now());
  const sleep = deps.sleep ?? defaultSleep;
  const token = deps.token ?? `${now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

  const request = { token, boardId, scale, at: now() };
  await sdk.storage.global.set(RENDER_REQUEST_KEY, request);

  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    await sleep(pollMs);
    let result = null;
    try {
      result = await sdk.storage.global.get(RENDER_RESULT_KEY);
    } catch {
      /* a read failure is retried by the loop, not fatal */
    }
    if (!result || result.token !== token) continue;

    if (result.ok && result.file) {
      return {
        ok: true,
        token,
        boardId: result.boardId ?? boardId ?? null,
        file: result.file,
        bytes: result.bytes ?? null,
        width: result.width ?? null,
        height: result.height ?? null,
        // Where the elements came from: the page's live canvas (includes unsaved
        // strokes) or the saved file. Reported rather than flattened, because the two
        // can differ and only the caller can judge whether that matters.
        source: result.source ?? null,
      };
    }
    return {
      ok: false,
      token,
      boardId: result.boardId ?? boardId ?? null,
      reason: result.reason ?? "page-error",
      error: result.error ?? "页面渲染失败",
    };
  }

  // Nobody answered, which in practice means the card is closed: rendering is the
  // one thing that has no fallback here.
  //
  // The request is removed before returning. A request left in storage is not inert:
  // the bridge replays whatever it finds on mount, so opening the card an hour later
  // would rasterize a board nobody asked about and drop a stray PNG in `exports/`.
  // Cleaning up here means a failed attempt leaves the store exactly as it found it.
  try {
    await sdk.storage.global.delete(RENDER_REQUEST_KEY);
  } catch (err) {
    console.warn("[excalidraw] could not clear the render request:", err?.message || err);
  }

  return {
    ok: false,
    token,
    boardId,
    reason: "timeout",
    error:
      `等了 ${Math.round(timeoutMs / 1000)} 秒没有回应。渲染只能由打开的页面完成（后端没有画布），` +
      `请先打开白板卡片，或先用 board_share 开一张预览卡再试。`,
  };
}

/** Clear the handshake keys, so a stale request is not replayed on the next open. */
export async function clearRenderHandshake(sdk) {
  for (const key of [RENDER_REQUEST_KEY, RENDER_RESULT_KEY]) {
    try {
      await sdk.storage.global.delete(key);
    } catch (err) {
      console.warn(`[excalidraw] could not clear ${key}:`, err?.message || err);
    }
  }
}
