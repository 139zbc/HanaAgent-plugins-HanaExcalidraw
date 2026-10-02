import { hana } from "@hana/plugin-sdk";
import { unwrapStored } from "./storageValue.js";
import { ACTIVE_BOARD_KEY, SHARED_BOARD_KEY } from "../lib/storageKeys.js";

/**
 * Board API, called from the card page.
 *
 * `hana.api.fetch(path)` resolves against `/api/apps/hana-excalidraw/routes/…` and
 * attaches the surface credential, so the backend decides record shape — the
 * page never writes storage keys itself.
 */

export const DEFAULT_BOARD_ID = "main";

const EMPTY_SCENE = { appState: { viewBackgroundColor: "#ffffff" }, elements: [] };

async function request(path, init) {
  const res = await hana.api.fetch(path, init);
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`${init?.method || "GET"} ${path} -> ${res.status} ${detail.slice(0, 200)}`);
  }
  return res.json();
}

export async function loadBoard(boardId = DEFAULT_BOARD_ID) {
  const { board } = await request(`/boards/${encodeURIComponent(boardId)}`);
  return board ?? null;
}

/** Load a board for `initialData`. Must never reject: Excalidraw would sit on its loading state forever. */
export async function loadBoardScene(boardId = DEFAULT_BOARD_ID) {
  try {
    const board = await loadBoard(boardId);
    return board?.scene ?? { ...EMPTY_SCENE };
  } catch (err) {
    console.warn("[excalidraw] board load failed, starting empty:", err?.message || err);
    window.__boardDiag?.errors?.push("load: " + (err?.message || err));
    return { ...EMPTY_SCENE };
  }
}

export async function loadBoards() {
  try {
    const { boards } = await request("/boards");
    return Array.isArray(boards) ? boards : [];
  } catch (err) {
    console.warn("[excalidraw] board list failed:", err?.message || err);
    return [];
  }
}

/**
 * The panel's feed. Deliberately not `loadBoards()`: that returns whole scenes,
 * and the panel only needs counts and titles. Shipping 36 elements per board to
 * render five rows is waste the 400px panel does not need.
 *
 * The shape is asserted rather than coerced. Returning `[]` on anything
 * unexpected is what made a swallowed route look like an empty feature list, and
 * an empty list is a plausible-looking answer — it does not look like an error.
 */
export async function loadBoardSummary() {
  const data = await request("/boards/summary");
  if (!Array.isArray(data?.boards)) {
    throw new Error(
      `/boards/summary returned ${JSON.stringify(data)?.slice(0, 120)} — expected { boards: [...] }. ` +
        "If a param route such as /boards/:id is registered before it, the static path is shadowed.",
    );
  }
  return data.boards;
}

export async function deleteBoard(boardId) {
  return request(`/boards/${encodeURIComponent(boardId)}`, { method: "DELETE" });
}

/** Create a new empty file. The id is minted by the backend. */
export async function createBoard({ title, id } = {}) {
  return request(`/boards`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title, id }),
  });
}

/** Rename a file. Does not move the scene revision. */
export async function renameBoard(boardId, title) {
  return request(`/boards/${encodeURIComponent(boardId)}/meta`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title }),
  });
}

/**
 * Where a board's file lives — and, unless asked not to, opens it.
 *
 * The opening is the backend's. `hana.external.open` looks like the right
 * capability for this, and it is, but the host grants it through a ledger with
 * no manifest fallback (`ledger.query(...)?.decision === "allowed"`), so an app
 * cannot obtain it by declaring it — the host answers `Plugin UI capability
 * "external.open" has not been granted`. `app/process.spawn` *is* granted by a
 * manifest line.
 *
 * Pass `{ launch: false }` for the locations without the side effect, which is
 * how a test can check this route without opening a window on someone's desktop.
 */
export async function revealBoard(boardId, options = {}) {
  return request(`/boards/${encodeURIComponent(boardId)}/reveal`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ launch: options.launch !== false }),
  });
}

/**
 * Move a file to an absolute slot, in one request.
 *
 * `to` is a *request* for a position, not an order — the backend resolves it
 * against the list it just read and clamps it. This exists for drag-to-reorder:
 * crossing a six-slot gap with one-step moves is six locked, order-rewriting
 * round trips, any of which can be interrupted, and there is no undo.
 */
export async function moveBoardTo(boardId, to) {
  return request(`/boards/${encodeURIComponent(boardId)}/move`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ to }),
  });
}

/**
 * Hand a rasterized scene to the backend so it can write it under `dataDir`.
 *
 * Lives here, not in the card component, because this is the module that already
 * holds the `hana` handle. Calling `hana.api.fetch` from a component that never
 * imported `hana` throws a ReferenceError the surrounding try/catch swallows —
 * the button then appears to do nothing at all, which is how this bug presented.
 */
export async function uploadExport(boardId, { format, dataUrl, count }) {
  return request(`/boards/${encodeURIComponent(boardId)}/export`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ format, dataUrl, count }),
  });
}

/** Strip the `data:...;base64,` prefix, leaving only the encoded bytes. */
export function base64FromDataUrl(dataUrl) {
  const match = /^data:(?:[^;,]+)?(;base64)?,(.*)$/s.exec(String(dataUrl ?? ""));
  if (!match) throw new Error("not a data URL");
  if (!match[1]) throw new Error("data URL is not base64");
  return match[2] || "";
}

/** Whether this host can offer a save dialog. Checks the method, not a version. */
export function canSaveWithDialog() {
  return typeof hana?.resources?.saveFile === "function";
}

/** A filename safe on Windows and readable: illegal characters become spaces. */
function safeStem(text, fallback) {
  const stem = String(text ?? "")
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/[. ]+$/, "")
    .trim()
    .slice(0, 60);
  return stem || fallback;
}

function stampForName() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/**
 * Deliver an exported file, preferring a real save dialog.
 *
 * The user picks the place when the host can ask (`hana.resources.saveFile` opens
 * the platform dialog). Otherwise the file lands in the app's own `exports/`
 * folder, which is the behaviour this had before — an honest fallback rather than
 * a silent failure.
 *
 * Lives here, not in the component, because this module already holds the `hana`
 * handle. Calling `hana.*` from a component that never imported it is a
 * ReferenceError that a surrounding try/catch turns into a dead button (R21).
 *
 * Outcomes are returned distinctly: `saved` / `canceled` / `conflict` /
 * `download` / `folder`, because "the user pressed cancel" and "the write failed"
 * are not the same event and must not share a status message.
 *
 * `deps` exists so those outcomes can be tested without a live host: the two
 * effects this function performs — asking for a save location, and writing to the
 * app folder — are injectable. Defaults are the real implementations.
 */
export async function deliverExport({ boardId, format, dataUrl, title, deps = {} }) {
  const mimeType = format === "svg" ? "image/svg+xml" : "image/png";
  const suggestedName = `${safeStem(title, boardId)}-${stampForName()}.${format}`;
  const saveFile = deps.saveFile !== undefined ? deps.saveFile : defaultSaveFile();
  const fallback = deps.writeToAppFolder ?? writeToAppFolder;

  if (typeof saveFile === "function") {
    let result;
    try {
      result = await saveFile({
        suggestedName,
        mimeType,
        contentBase64: base64FromDataUrl(dataUrl),
      });
    } catch (err) {
      // A revoked capability or an unsupported surface arrives as an exception.
      // Report it and fall back rather than leaving the button dead.
      const message = String(err?.message || err);
      const written = await fallback(boardId, format, dataUrl);
      return { ...written, dialogError: message };
    }
    switch (result?.kind) {
      case "saved":
        return {
          outcome: "saved",
          path: result.resource?.path ?? null,
          overwritten: Boolean(result.overwritten),
          name: suggestedName,
        };
      case "canceled":
        return { outcome: "canceled" };
      case "conflict":
        return {
          outcome: "conflict",
          path: result.resource?.path ?? null,
          mayHaveWritten: Boolean(result.mayHaveWritten),
        };
      case "download-started":
        // The contract says this is not evidence bytes reached disk, so it is
        // reported as its own outcome instead of being called a success.
        return { outcome: "download", name: suggestedName };
      default:
        return { outcome: "unknown", detail: result?.kind ?? "no result" };
    }
  }

  return fallback(boardId, format, dataUrl);
}

/** The host's save-dialog call, or null when this surface cannot offer one. */
function defaultSaveFile() {
  if (typeof hana?.resources?.saveFile !== "function") return null;
  return (input) => hana.resources.saveFile(input);
}

/** Fallback destination: the app's own `exports/`, written by the backend. */
async function writeToAppFolder(boardId, format, dataUrl) {
  const res = await uploadExport(boardId, { format, dataUrl });
  if (!res?.ok) return { outcome: "failed", detail: res?.error ?? "unknown" };
  return { outcome: "folder", path: res.file, name: res.file, bytes: res.bytes };
}

/**
 * Which board the card is showing.
 *
 * Named `ui:activeBoard`, not `board:active`: the board listeners match any key
 * starting with `board:`, so a key named `board:active` made every "switch board"
 * write look like a scene change. That fired a remote pull, which wrote again,
 * and the revision counter ran away (observed: rev 107 -> 127 in a few minutes).
 * Keeping the two key families apart is the whole fix.
 *
 * This key is also the cross-document channel: the Function Panel is a separate
 * page, so it cannot dispatch an event into the canvas document. It writes here
 * and the card picks it up.
 */
export const ACTIVE_KEY = ACTIVE_BOARD_KEY;

/**
 * Which board was most recently shared into the conversation.
 *
 * Written by `board_share`. It exists because the host hands a preview card no
 * payload and no query string, and the route must stay query-free to keep
 * matching the manifest's declared `route` exactly — so there is nowhere in the
 * card itself to say *which* board this is.
 *
 * `ui:activeBoard` was carrying that job, and it answers a different question:
 * it is "what the user happens to be looking at". Those coincide only when the
 * agent happens to have just drawn on the board the user was already on, which
 * is the one case where nothing is wrong. Share any other board and the card is
 * titled with the shared board's name while painting a different one.
 */
export const SHARED_KEY = SHARED_BOARD_KEY;

export async function switchBoard(boardId) {
  try {
    await hana.storage.global.set(ACTIVE_KEY, { boardId, at: Date.now() });
  } catch (err) {
    console.warn("[excalidraw] could not remember board choice:", err?.message || err);
  }
  return boardId;
}

/**
 * Record preview state where it can be read from disk.
 *
 * The page cannot prove its own behaviour through the chat: `track` needs a
 * completed handshake and has silently dropped records before, and `read_state`
 * reports an empty object for this card. Storage is the channel that has worked
 * every time (`ui:panelProbe`, `ui:shareProbe`), so preview facts go there too.
 *
 * `key` exists because two different measurements (the active tool, and whether
 * the editor chrome is hidden) happen on different timers. Sharing one key meant
 * the later write replaced the earlier one, so each gets its own.
 */
export async function probePreview(payload, key = "ui:previewProbe") {
  try {
    await hana.storage.global.set(key, { at: Date.now(), ...payload });
  } catch (err) {
    console.warn("[excalidraw] preview probe write failed:", err?.message || err);
  }
}

export async function readActiveBoard() {
  try {
    // The unwrap is load-bearing. Without it this reads `undefined` off the
    // host's `{key, value}` envelope on every call, so the function returned
    // null every time — and the "remember the board you were on" behaviour it
    // exists for silently did nothing. See storageValue.js and 开发记录 R57.
    const value = unwrapStored(await hana.storage.global.get(ACTIVE_KEY));
    const id = typeof value === "string" ? value : value?.boardId;
    return typeof id === "string" && id ? id : null;
  } catch {
    return null;
  }
}

/**
 * Which board a preview card should paint.
 *
 * Two keys answer it and the newer timestamp wins, rather than one key being
 * declared the winner. `ui:sharedBoard` is written when the agent shares;
 * `ui:activeBoard` is written whenever the user picks a board by hand. Asking
 * "which happened last" needs no tie-break rule and no window: sharing a board
 * and then switching away is a legitimate sequence that should show the shared
 * one, and switching to a board and then having the agent share something else
 * should show the new one. Either way the later statement is the one the user
 * was last told to look at.
 *
 * Both are best-effort: a card with neither shows `main`, which is the board the
 * app opens on.
 */
export async function readPreviewBoard() {
  const pick = (raw) => {
    const value = unwrapStored(raw);
    const id = typeof value === "string" ? value : value?.boardId;
    return typeof id === "string" && id ? { id, at: Number(value?.at) || 0 } : null;
  };
  try {
    const [shared, active] = await Promise.all([
      hana.storage.global.get(SHARED_KEY),
      hana.storage.global.get(ACTIVE_KEY),
    ]);
    const s = pick(shared);
    const a = pick(active);
    if (s && a) return s.at >= a.at ? s.id : a.id;
    return (s || a)?.id ?? null;
  } catch {
    return null;
  }
}

/**
 * Persist the scene through the CAS route.
 *
 * The card autosaves, and Excalidraw fires onChange for reasons that are not the
 * user editing anything — font loading reflows text, focus changes repaint. A
 * last-writer-wins save therefore lets an open card silently overwrite whatever
 * anyone else wrote, which is exactly how an agent's diagram disappears.
 * Compare-and-set turns that into a visible conflict instead.
 */
export async function saveBoardScene(scene, boardId = DEFAULT_BOARD_ID, updatedBy = "user", baseRev = null) {
  const res = await hana.api.fetch(`/boards/${encodeURIComponent(boardId)}/scene/cas`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    // `boardId` is echoed in the body on purpose. The backend refuses when it
    // disagrees with the path, so content that belongs to one board cannot be
    // written into another even if the page gets its ids crossed.
    body: JSON.stringify({ scene, updatedBy, baseRev, boardId }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `save -> ${res.status}`);
    err.status = res.status;
    err.payload = data;
    throw err;
  }
  return data;
}

/**
 * Watch for a write to any board, from anywhere.
 *
 * Scenes live in files, and a file write fires nothing on the host's change
 * channel. So the backend writes a small `boardpulse` signal through storage
 * after **every** write, and this is what pages listen to. The signal carries no
 * content: the receiver re-reads the board it cares about and compares
 * revisions, which stays correct even when the host coalesces several signals
 * into one.
 *
 * It is sent for the page's own saves too, not only the agent's. A page is
 * immune to its own signal — `pullRemote` returns early when the revision has
 * not moved — while a *second* open window is not, and that is the case this
 * exists for.
 *
 * The callback receives the signal, which carries the revision it belongs to.
 * `onChanged` reports only which keys moved, so the value is read back: a few
 * bytes, against the full scene a pull would otherwise fetch. That is the whole
 * reason it is worth a second round trip — the scene is the expensive part.
 */
export const BOARD_PULSE_KEY = "boardpulse";

export function subscribeBoardPulse(callback) {
  return hana.storage.global.onChanged((keys) => {
    if (!Array.isArray(keys) || !keys.includes(BOARD_PULSE_KEY)) return;
    hana.storage.global
      .get(BOARD_PULSE_KEY)
      // Unwrapped on purpose: `onChanged` reports which keys moved, so the value
      // has to be read back, and that read comes back in the host's `{key, value}`
      // envelope. Handing the envelope to the callback would compare
      // `envelope.boardId` — `undefined` — against a real id and never match.
      .then((raw) => callback(unwrapStored(raw)))
      .catch(() => callback(null));
  });
}

/* ------------------------------------------------------------------ *
 * Panel <-> card channel
 *
 * The Function Panel is its own document. Declaring `functionPanel.route` makes
 * the host render an iframe instead of drawing `panel.set` primitives, and the
 * two documents share no JavaScript objects — so everything they need to tell
 * each other goes through App storage, which is what the host documentation
 * points at for exactly this.
 *
 * Three keys, and the split is by who writes:
 *
 *   ui:boardCommand   panel -> card.  "switch to this board", "export png".
 *                      Only two verbs, because only two things need the canvas.
 *   ui:boardStatus    card  -> panel.  Export progress and the one-line outcome.
 *                      One key rather than two: they change together, and a panel
 *                      that has to reconcile two clocks is a panel that can
 *                      briefly disagree with itself.
 *   ui:activeBoard    both.          Written by whoever last chose a board.
 *
 * Every command carries `at`, and readers ignore one that is older than what
 * they already have. Storage is last-writer-wins, but a panel that mounts half a
 * second after the card wrote must not replay a command that has already been
 * carried out — "switch" is idempotent, "export" is not.
 */

/** Panel -> card. See the note above for why these are the only two verbs. */
export const COMMAND_KEY = "ui:boardCommand";

/** Card -> panel. `{ exporting, notice, at }`. */
export const STATUS_KEY = "ui:boardStatus";

const now = () => Date.now();

/**
 * Hand a command to the card.
 *
 * `export` is the reason a timestamp guard exists at all: the sidebar re-reads
 * the key when it mounts, and without `at` a fresh panel would fire the last
 * export again on open.
 */
export async function sendBoardCommand(command) {
  try {
    await hana.storage.global.set(COMMAND_KEY, { ...command, at: now() });
    return true;
  } catch (err) {
    console.warn("[excalidraw] could not deliver panel command:", err?.message || err);
    return false;
  }
}

/** Card side: run `handler(command)` for each command newer than `sinceAt`. */
export function subscribeBoardCommand(handler, sinceAt = 0) {
  let last = sinceAt;
  return hana.storage.global.onChanged((keys) => {
    if (!Array.isArray(keys) || !keys.includes(COMMAND_KEY)) return;
    hana.storage.global
      .get(COMMAND_KEY)
      .then((raw) => {
        const command = unwrapStored(raw);
        if (!command || typeof command !== "object") return;
        const at = Number(command.at) || 0;
        if (at <= last) return;
        last = at;
        handler(command);
      })
      .catch(() => {});
  });
}

/** Panel side: repaint on a new status. `notice` may be null, which clears it. */
export async function publishBoardStatus({ exporting = "", notice = null } = {}) {
  try {
    await hana.storage.global.set(STATUS_KEY, { exporting, notice, at: now() });
  } catch (err) {
    console.warn("[excalidraw] could not publish panel status:", err?.message || err);
  }
}

export function subscribeBoardStatus(handler) {
  let last = 0;
  return hana.storage.global.onChanged((keys) => {
    if (!Array.isArray(keys) || !keys.includes(STATUS_KEY)) return;
    hana.storage.global
      .get(STATUS_KEY)
      .then((raw) => {
        const status = unwrapStored(raw);
        if (!status || typeof status !== "object") return;
        const at = Number(status.at) || 0;
        if (at <= last) return;
        last = at;
        handler({ exporting: status.exporting || "", notice: status.notice ?? null });
      })
      .catch(() => {});
  });
}
