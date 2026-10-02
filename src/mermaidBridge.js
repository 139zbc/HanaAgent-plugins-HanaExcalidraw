import { unwrapStored } from "./storageValue.js";
import { RESULT_KEY, REQUEST_KEY, DEFAULT_TIMEOUT_MS } from "../lib/mermaid.js";

/**
 * The page half of the Mermaid handshake.
 *
 * The agent's tool cannot convert Mermaid: layout needs a document to measure text
 * in, so `parseMermaidToExcalidraw` runs here instead (see lib/mermaid.js). This
 * watches for a request, converts, writes through the normal compare-and-set route,
 * and reports the outcome.
 *
 * Three deliberate choices:
 *
 * 1. **Merge against the *stored* board, not the canvas.** The stored record is
 *    authoritative and carries the revision the CAS needs. Reading elements off the
 *    canvas would risk committing a scene that differs from what the store holds,
 *    which is how one board's content once landed in another (R31).
 *
 * 2. **Commit as `agent`.** The diagram is the agent's work even though this page
 *    performs the write; the revision history should say so.
 *
 * 3. **Storage is read through `hostStorage`.** The host answers reads with a
 *    `{ key, value }` wrapper, so `request?.token` off the raw result is `undefined`
 *    every time and the bridge would do nothing, silently and forever. That is
 *    开发记录 R57, and the unwrapping lives in `hostStorage` so this file never has
 *    to think about it.
 *
 * The request carries a token rather than relying on a timestamp. The panel's
 * command channel uses timestamps because a command is fire-and-forget; this one
 * is a request/response pair, and a token is what correlates an answer with the
 * question that caused it.
 */

/** How far below existing content an appended diagram starts. */
const APPEND_GAP = 80;

/** Keeps a single request from re-running when the page remounts. */
const HANDLED_KEY = "ui:mermaidHandled";

/** Bounds of the live elements, or null when there are none. */
function sceneBounds(elements) {
  const live = elements.filter((e) => !e.isDeleted);
  if (!live.length) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const el of live) {
    minX = Math.min(minX, el.x);
    minY = Math.min(minY, el.y);
    maxY = Math.max(maxY, el.y + (el.height ?? 0));
  }
  return { minX, minY, maxY };
}

/**
 * Move every element by the same offset.
 *
 * Uniform translation is why this is done *after* conversion rather than on the
 * skeletons: bindings are by id and relative geometry is unchanged, so bound labels
 * and arrow endpoints stay correct without recomputing any of them.
 */
function translate(elements, dx, dy) {
  if (!dx && !dy) return elements;
  return elements.map((el) => ({ ...el, x: el.x + dx, y: el.y + dy }));
}

/**
 * Convert a request into elements and commit them.
 *
 * `load` and `save` are injected rather than imported. Importing the board client
 * would drag `@hana/plugin-sdk` in behind it, which cannot load outside a browser —
 * and then none of the merge or commit logic below could be tested at all. The
 * browser-only parts (the Mermaid parse and the Excalidraw conversion) are injected
 * for the same reason; what is left is ordinary arithmetic and one CAS call.
 */
export async function runMermaidConversion({ boardId, mermaid, mode = "append", converters, load, save }) {
  if (typeof load !== "function" || typeof save !== "function") {
    throw new Error("runMermaidConversion needs `load` and `save`");
  }
  const { parse, toElements } = converters;
  const { elements: skeletons } = await parse(mermaid);
  if (!Array.isArray(skeletons) || !skeletons.length) {
    return { ok: false, reason: "empty-diagram", error: "Mermaid 没有产出任何图元" };
  }

  const produced = toElements(skeletons);
  if (!Array.isArray(produced) || !produced.length) {
    return { ok: false, reason: "empty-diagram", error: "转换后没有图元" };
  }

  const board = await load(boardId);
  if (!board) return { ok: false, reason: "no-board", error: `场景 ${boardId} 不存在` };

  const existing = board.scene?.elements ?? [];
  let elements;
  if (mode === "replace") {
    elements = produced;
  } else {
    const bounds = sceneBounds(existing);
    // Aim to start just below whatever is already there. Without existing content
    // the diagram keeps Mermaid's own origin, so a first draw lands where it was
    // laid out.
    // Both derived from the live bounds. The `- 0` these used to carry was an
    // edit remnant from when the offsets were computed against something else;
    // the values are simply the bounds.
    const dx = bounds ? bounds.minX : 0;
    const dy = bounds ? bounds.maxY + APPEND_GAP : 0;
    elements = [...existing, ...translate(produced, dx, dy)];
  }

  const saved = await save(
    { elements, appState: board.scene?.appState ?? {} },
    boardId,
    "agent",
    board.rev,
  );
  return { ok: true, boardId, count: produced.length, rev: saved?.rev ?? null, total: elements.length };
}

/**
 * Adapt the host's storage to plain values.
 *
 * The card-side `storage.get` answers the host's `{ key, value }` wrapper, not the
 * value; reading a field off it yields `undefined` every time, which reads as
 * "nothing stored yet" and so fails silently (开发记录 R57, and note that the
 * *server-side* call returns the bare value — the same method name, two shapes).
 *
 * Unwrapping happens **here, at the one boundary**, rather than at each read. Then
 * everything downstream — including `installMermaidBridge` — deals in plain values
 * and has no reason to know the wrapper exists. Exported so a test can drive it
 * with a deliberately wrapping fake and prove the boundary actually unwraps.
 */
export function hostStorage(host) {
  const global = host?.storage?.global;
  if (!global) throw new Error("hostStorage needs hana.storage.global");
  return {
    get: async (key) => unwrapStored(await global.get(key)),
    set: (key, value) => global.set(key, value),
    onChanged: (cb) => global.onChanged(cb),
  };
}

/**
 * Subscribe to conversion requests while this page is mounted.
 *
 * Returns a disposer. `converters`, `load`, `save` and the reporting hooks are all
 * injected so the same function serves the real card and a test.
 */
export function installMermaidBridge({
  enabled,
  storage,
  converters,
  load,
  save,
  onCommitted,
  beforeConvert,
  track,
  probe,
  log = console,
}) {
  if (!enabled) return () => {};

  let disposed = false;

  const handle = async () => {
    if (disposed) return;
    let request = null;
    try {
      request = await storage.get(REQUEST_KEY);
    } catch (err) {
      log.warn("[excalidraw] mermaid: could not read request:", err?.message || err);
      return;
    }
    if (!request?.token || !request.mermaid) return;

    // An orphan from a call that was cut short — most likely a host restart. A request
    // older than the tool's own budget has nobody waiting: the tool gave up and the
    // answer would go nowhere. Without this, a page opened minutes later redraws a
    // board nobody asked about (the same replay that R73 records for rendering).
    const age = Date.now() - Number(request.at);
    if (Number.isFinite(age) && age > DEFAULT_TIMEOUT_MS) {
      log.warn(
        `[excalidraw] mermaid: ignoring a ${Math.round(age / 1000)}s-old request (no one can still be waiting)`,
      );
      return;
    }

    // Already done: a remount or a second tab must not draw it twice.
    let handled = null;
    try {
      handled = await storage.get(HANDLED_KEY);
    } catch {
      /* a missing handled marker just means nothing has been processed yet */
    }
    if (handled?.token === request.token) return;

    await storage.set(HANDLED_KEY, { token: request.token, at: Date.now() });

    // Persist any edits still sitting in the debounce window first. The conversion
    // commits with a compare-and-set, and a user stroke saved *after* it would
    // otherwise raise a conflict banner for no reason the user could understand.
    try {
      await beforeConvert?.();
    } catch (err) {
      log.warn("[excalidraw] mermaid: could not flush pending edits:", err?.message || err);
    }

    let outcome;
    try {
      outcome = await runMermaidConversion({
        boardId: request.boardId,
        mermaid: request.mermaid,
        mode: request.mode,
        converters,
        load,
        save,
      });
    } catch (err) {
      // Mermaid throws on a syntax error, and its message is the useful part —
      // pass it through rather than replacing it with "conversion failed".
      outcome = {
        ok: false,
        reason: "mermaid-error",
        error: String(err?.message || err).slice(0, 400),
      };
    }

    try {
      await storage.set(RESULT_KEY, { token: request.token, at: Date.now(), ...outcome });
    } catch (err) {
      log.warn("[excalidraw] mermaid: could not write result:", err?.message || err);
    }

    if (outcome.ok) {
      track?.("board:mermaid", {
        boardId: request.boardId,
        mode: request.mode,
        count: outcome.count,
        rev: outcome.rev,
      });
      probe?.({ outcome: "mermaid-converted", ...outcome, boardId: request.boardId });
      // The page's own canvas still shows the old scene; let the caller repaint
      // from the new revision rather than waiting for a broadcast.
      onCommitted?.(outcome);
    } else {
      track?.("board:mermaid-error", { reason: outcome.reason, error: outcome.error });
      probe?.({ outcome: "mermaid-failed", ...outcome, boardId: request.boardId });
    }
  };

  const off = storage.onChanged((keys) => {
    if (Array.isArray(keys) && keys.includes(REQUEST_KEY)) handle();
  });
  // A request may already be waiting when this page mounts — the common case, since
  // the tool is usually called while the card is open but not necessarily focused.
  handle();

  return () => {
    disposed = true;
    off?.();
  };
}
