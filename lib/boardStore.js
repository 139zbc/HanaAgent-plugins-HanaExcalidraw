import fs from "node:fs/promises";

/**
 * Board persistence: one `.excalidraw` file per board, named after its title.
 *
 *   <dataDir>/boards/插件测试用例.excalidraw
 *
 * The file keeps the standard shape (`type` / `version` / `source` / `elements` /
 * `appState` / `files`) so Excalidraw itself can open it, plus a `hana` key for
 * the metadata this app needs. Excalidraw ignores unknown top-level keys, so the
 * extra key costs nothing in interop.
 *
 * Two identities, deliberately kept apart:
 *
 *   - **`id`** is the stable identity. It is what routes, `ui:activeBoard` and the
 *     save-ownership guard use, and it never changes — a rename must not
 *     invalidate a page that is mid-edit. It lives in `hana.id`.
 *   - **the filename** is a *rendering* of the title, so the file on disk is
 *     recognisable by the name shown in the list. It changes on rename.
 *
 * The filename is a sanitised form of the title, never the raw title: `\ / : * ?
 * " < > |`, control characters, Windows device names and trailing dots/spaces are
 * all illegal in a filename. The full title is preserved in `hana.title`, so the
 * panel still shows exactly what the user typed.
 *
 * `ctx.storage` is NOT the board store. It keeps exactly two things:
 * `ui:activeBoard` (which file the page is showing) and `boardpulse`, a change
 * signal — the host's `storage.global.onChanged` is the only broadcast channel it
 * offers, and files on disk fire nothing. Content goes to files, the signal goes
 * through storage, and neither is a copy of the other.
 *
 * The app process stays the single writer (开发记录 D3): every write goes through
 * this module's serialization queue, and the page reaches it over HTTP.
 */

export const DEFAULT_BOARD_ID = "main";
export const FILE_EXT = ".excalidraw";
/** Metadata namespace inside the file. Excalidraw ignores unknown top-level keys. */
export const HANA_KEY = "hana";
/** Legacy single-blob storage prefix. Read once, at migration. */
export const BOARD_PREFIX = "board:";
/** Change signal, so pages learn about a write without polling. */
export const PULSE_KEY = "boardpulse";

/**
 * Only the appState that still means something in a later session. The rest of
 * Excalidraw's appState is per-session UI state — open sidebar, active tool,
 * selection — and persisting it makes the same file behave differently on a
 * different machine.
 *
 * `zoom` / `scrollX` / `scrollY` are deliberately **not** here.
 *
 * The viewport is not part of the drawing, and storing it made the viewport part
 * of the *revision*. Every pan or zoom fires Excalidraw's `onChange`, which saved;
 * the saved scene then differed from the stored one only in those three fields,
 * and it bumped `rev` regardless. Two consequences, both real: panning around a
 * board silently invalidated the revision every other open window was holding
 * (turning a harmless look-around into a save conflict), and it rewrote a
 * possibly-megabyte file each time.
 *
 * The old behaviour is not replaced in kind: a board now opens fitted to its
 * content, which is what storing the viewport was trying to achieve and did not
 * — a stored position also goes *stale* the moment the drawing changes size, and
 * one board in this workspace opens onto empty space for exactly that reason.
 */
const PERSISTED_APP_STATE = [
  "viewBackgroundColor",
  "gridSize",
  "gridStep",
];

export function pickAppState(appState) {
  const out = {};
  if (!appState || typeof appState !== "object") return out;
  for (const key of PERSISTED_APP_STATE) {
    const value = appState[key];
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/**
 * The fields that make a drawing what it is, in a fixed order.
 *
 * Written out rather than derived from the element's own keys, for two reasons:
 *
 *   - Bookkeeping must not count. Excalidraw rewrites `version`, `versionNonce`
 *     and `updated` on its own, and a difference in those alone is not a change
 *     to the drawing. An open-ended "everything else" list would let a future
 *     field of that kind join silently and make every save look like an edit.
 *   - `index` is left out on purpose: it is z-order, which the element array
 *     already encodes, and it is the field most likely to be renumbered by a
 *     round trip without anything moving.
 *
 * `version` is *not* used as a change signal, which is why the geometry is listed
 * explicitly. `expandElement` (boardFormat.js) preserves an existing element's
 * version when the model edits it, so "the version moved" is not a reliable proxy
 * for "the element moved".
 */
const CONTENT_FIELDS = [
  "type",
  "x",
  "y",
  "width",
  "height",
  "angle",
  "strokeColor",
  "backgroundColor",
  "fillStyle",
  "strokeWidth",
  "strokeStyle",
  "roughness",
  "opacity",
  "groupIds",
  "frameId",
  "roundness",
  "seed",
  "isDeleted",
  "boundElements",
  "link",
  "locked",
  "text",
  "originalText",
  "fontSize",
  "fontFamily",
  "textAlign",
  "verticalAlign",
  "lineHeight",
  "autoResize",
  "containerId",
  "points",
  "startBinding",
  "endBinding",
  "startArrowhead",
  "endArrowhead",
  "fileId",
  "scale",
  "status",
  "name",
];

/**
 * A stable fingerprint of what a scene would store.
 *
 * Compared against the same function applied to what is already on disk, so that
 * a write which changes nothing is recognised and skipped. Two sources are being
 * compared — a scene that came out of a JSON file and one that came out of the
 * live editor — so the fingerprint is built by **projecting a fixed field list**,
 * never by `JSON.stringify`-ing the objects. The same element read from a file and
 * from Excalidraw can carry its keys in a different order, and a raw stringify
 * would call that a change and write the file again, which is the exact cost this
 * exists to avoid.
 */
export function sceneContentSignature(elements, appState) {
  const list = Array.isArray(elements) ? elements : [];
  const rows = list.map((el) => {
    // `?? null` normalises a missing key to an explicit null so both sources
    // agree; it leaves `false` and `0` alone, which are real values here.
    const row = [el?.id ?? null];
    for (const field of CONTENT_FIELDS) row.push(el?.[field] ?? null);
    return JSON.stringify(row);
  });
  return `${rows.join("\n")}\u0000${JSON.stringify(pickAppState(appState))}`;
}

/* ------------------------------------------------------------------ *
 * Where boards live
 * ------------------------------------------------------------------ */

export function boardsDir(sdk) {
  const base = String(sdk?.dataDir ?? "").replace(/[\\/]+$/, "");
  if (!base) throw new Error("sdk.dataDir is required to locate the boards folder");
  return `${base}/boards`;
}

const fullPath = (sdk, name) => `${boardsDir(sdk)}/${name}`;

/** Board ids travel in URLs and storage keys: keep them safe ASCII. */
export const isSafeBoardId = (id) =>
  typeof id === "string" && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(id);

export function newBoardId() {
  return `b${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
}

const cleanTitle = (title) => {
  const t = typeof title === "string" ? title.trim() : "";
  return (t || "未命名画板").slice(0, 60);
};

/* ------------------------------------------------------------------ *
 * Filenames
 * ------------------------------------------------------------------ */

/** Characters Windows forbids in a filename, plus control codes. */
const ILLEGAL_IN_NAME = /[<>:"/\\|?*\u0000-\u001f]/g;
/** Device names that mean something special even with an extension. */
const RESERVED_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const MAX_STEM = 64;

/** Trim illegal characters and length without splitting a surrogate pair. */
function sanitizeStem(title, fallback) {
  let stem = String(title ?? "")
    .replace(ILLEGAL_IN_NAME, " ")
    .replace(/\s+/g, " ")
    .trim();
  // Windows silently strips a trailing dot or space, which would make the file
  // we asked for differ from the file that appears — so strip it ourselves.
  stem = stem.replace(/[. ]+$/, "");
  if (stem && RESERVED_NAMES.test(stem)) stem = `${stem}_`;
  stem = [...stem].slice(0, MAX_STEM).join("").replace(/[. ]+$/, "");
  return stem || fallback;
}

/**
 * The filename a board's title maps to.
 *
 * Falls back to the id when the title has nothing usable left after sanitising —
 * a title of `???` would otherwise produce an empty stem. This only affects the
 * name on disk; the panel keeps showing the original title.
 */
export function filenameForTitle(title, id) {
  return `${sanitizeStem(title, id)}${FILE_EXT}`;
}

/** Case-insensitive because Windows and macOS treat names that way. */
const nameKey = (name) => name.toLowerCase();

/**
 * A name in `desired` that no existing file holds.
 *
 * Two boards may legitimately share a title, so the second becomes
 * `Title (2).excalidraw`. `taken` is passed in when the caller already listed the
 * directory, to avoid a second readdir.
 */
function freeName(desired, taken) {
  if (!taken.has(nameKey(desired))) return desired;
  const stem = desired.slice(0, -FILE_EXT.length);
  for (let n = 2; n < 1000; n++) {
    const candidate = `${stem} (${n})${FILE_EXT}`;
    if (!taken.has(nameKey(candidate))) return candidate;
  }
  // A thousand boards with one title is not a real scenario; refuse to loop.
  throw new Error(`cannot find a free filename for ${desired}`);
}

async function listFilenames(sdk) {
  try {
    return await fs.readdir(boardsDir(sdk));
  } catch (err) {
    if (err?.code === "ENOENT") return [];
    throw err;
  }
}

/* ------------------------------------------------------------------ *
 * File format
 * ------------------------------------------------------------------ */

/** Board record -> standard `.excalidraw` document. */
function toFile(board) {
  return {
    type: "excalidraw",
    version: 2,
    source: "hana-excalidraw",
    elements: Array.isArray(board.scene?.elements) ? board.scene.elements : [],
    appState: pickAppState(board.scene?.appState),
    files: {},
    [HANA_KEY]: {
      id: board.id,
      title: board.title,
      order: Number.isFinite(board.order) ? board.order : undefined,
      rev: board.rev,
      createdAt: board.createdAt,
      updatedAt: board.updatedAt,
      updatedBy: board.updatedBy,
    },
  };
}

/**
 * `.excalidraw` document -> board record.
 *
 * A file without the `hana` key is legitimate: a diagram made in Excalidraw and
 * dropped into the folder. Its filename becomes its title, which is why such a
 * file already satisfies "the name on disk is the name in the list".
 *
 * For a file that *does* carry metadata, the title wins: the filename follows it,
 * not the other way round. That is the rule the panel depends on.
 */
function fromFile(idFromName, raw, mtimeMs) {
  const meta = raw?.[HANA_KEY] && typeof raw[HANA_KEY] === "object" ? raw[HANA_KEY] : {};
  const num = (v, fallback) => (Number.isFinite(v) ? v : fallback);
  const id = typeof meta.id === "string" && isSafeBoardId(meta.id) ? meta.id : idFromName;
  return {
    id,
    title: typeof meta.title === "string" && meta.title.trim() ? meta.title : idFromName,
    order: Number.isFinite(meta.order) ? meta.order : undefined,
    rev: num(meta.rev, 0),
    createdAt: num(meta.createdAt, mtimeMs),
    updatedAt: num(meta.updatedAt, mtimeMs),
    updatedBy: meta.updatedBy === "agent" ? "agent" : "user",
    scene: {
      type: "excalidraw",
      version: 2,
      source: "hana-excalidraw",
      appState: pickAppState(raw?.appState),
      elements: Array.isArray(raw?.elements) ? raw.elements : [],
    },
  };
}

/* ------------------------------------------------------------------ *
 * Single-writer serialization
 * ------------------------------------------------------------------ */

const queues = new Map();

/** Run `task` after any earlier task for the same board, never concurrently. */
export function serialize(boardId, task) {
  const previous = queues.get(boardId) || Promise.resolve();
  const run = previous.then(task, task);
  // The queue tail swallows failures so one rejected write cannot wedge the board.
  queues.set(
    boardId,
    run.then(
      () => {},
      () => {},
    ),
  );
  return run;
}

/* ------------------------------------------------------------------ *
 * Reading
 * ------------------------------------------------------------------ */

/**
 * `id -> filename`, a cache.
 *
 * Purely an optimisation: a miss re-scans the directory, so a stale entry (the
 * file was renamed outside the app) costs one extra scan rather than a wrong
 * answer. Nothing but the directory listing is authoritative.
 */
const fileIndex = new Map();

/** Read every board file. Invalid files are skipped, not fatal. */
async function scanBoards(sdk) {
  const dir = boardsDir(sdk);
  const names = await listFilenames(sdk);
  const found = [];
  for (const name of names) {
    if (!name.endsWith(FILE_EXT)) continue; // also excludes in-flight `.tmp` files
    let raw;
    let stat;
    try {
      [raw, stat] = await Promise.all([
        fs.readFile(fullPath(sdk, name), "utf8").then(JSON.parse),
        fs.stat(fullPath(sdk, name)),
      ]);
    } catch (err) {
      console.warn(`[excalidraw] skipping unreadable board file ${name}:`, err?.message || err);
      continue;
    }
    if (!raw || typeof raw !== "object") continue;
    found.push({ board: fromFile(name.slice(0, -FILE_EXT.length), raw, stat.mtimeMs), name });
  }

  // Deduplicate by id. An interrupted rename can leave two files for one board —
  // the new one is written before the old is removed, on purpose — and both would
  // otherwise list as separate boards. The newer copy wins.
  const byId = new Map();
  for (const entry of found) {
    const prev = byId.get(entry.board.id);
    if (!prev || (entry.board.updatedAt ?? 0) > (prev.board.updatedAt ?? 0)) {
      byId.set(entry.board.id, entry);
    }
  }

  fileIndex.clear();
  for (const [id, entry] of byId) fileIndex.set(id, entry.name);
  void dir;
  return [...byId.values()];
}

/** Where a board currently lives, or null. Rescans once when the cache misses. */
async function resolveFilename(sdk, id) {
  const cached = fileIndex.get(id);
  if (cached) return cached;
  const entries = await scanBoards(sdk);
  return entries.find((e) => e.board.id === id)?.name ?? null;
}

/**
 * The absolute path of a board's file, or null when it has none yet.
 *
 * For "show me this file in Explorer" — the one feature that cannot be served
 * from inside the app, because the host exposes no shell to a card (verified
 * against the shipped bundle: no `showItemInFolder`, no `openPath`, no
 * `shell.openExternal`). The path is derived from the store's own index, never
 * from the request, so this cannot be pointed at an arbitrary file.
 */
export async function boardFilePath(sdk, id) {
  const name = await resolveFilename(sdk, id);
  return name ? fullPath(sdk, name) : null;
}

/**
 * Read one board. Used internally by the migration, which must not re-enter it.
 *
 * Prefer `readBoard`: a read that skips migration can report "this board does not
 * exist" while its content is still sitting in legacy storage.
 */
async function readBoardRaw(sdk, id) {
  if (!isSafeBoardId(id)) return null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const name = await resolveFilename(sdk, id);
    if (!name) return null;
    try {
      const [text, stat] = await Promise.all([
        fs.readFile(fullPath(sdk, name), "utf8"),
        fs.stat(fullPath(sdk, name)),
      ]);
      return fromFile(id, JSON.parse(text), stat.mtimeMs);
    } catch (err) {
      // The cached name went stale (someone renamed the file outside the app).
      // Drop it and rescan once before giving up.
      if (err?.code === "ENOENT" && attempt === 0) {
        fileIndex.delete(id);
        continue;
      }
      if (err?.code === "ENOENT") return null;
      throw err;
    }
  }
  return null;
}

/**
 * Read one board, migrating legacy storage first.
 *
 * The migration MUST run before the read answers. This is not tidiness — it is
 * the fix for a data-loss bug: the page read its board before the migration had
 * written the file, got "no such board", and painted an empty canvas. It then
 * adopted the post-migration revision from a separate read, and its next
 * autosave wrote that emptiness back over 36 real elements at a perfectly valid
 * base revision. Reading is the first thing that happens, so reading is where the
 * migration has to be guaranteed.
 */
export async function readBoard(sdk, id) {
  await ensureNormalized(sdk);
  return readBoardRaw(sdk, id);
}

/**
 * File order is stored, not derived.
 *
 * Sorting by `updatedAt` means the list rearranges itself every time anything is
 * edited, which fights a user who has arranged their own files. So `order` is
 * authoritative once present, and the fallback chain only exists for files
 * written before this app managed them: `order` -> `createdAt` -> `updatedAt` -> `id`.
 * A deterministic total order matters — an unstable sort makes rows jump.
 */
function compareBoardOrder(a, b) {
  const ao = Number.isFinite(a.order) ? a.order : Number.POSITIVE_INFINITY;
  const bo = Number.isFinite(b.order) ? b.order : Number.POSITIVE_INFINITY;
  if (ao !== bo) return ao - bo;
  const ac = Number.isFinite(a.createdAt) ? a.createdAt : 0;
  const bc = Number.isFinite(b.createdAt) ? b.createdAt : 0;
  if (ac !== bc) return ac - bc;
  const au = Number.isFinite(a.updatedAt) ? a.updatedAt : 0;
  const bu = Number.isFinite(b.updatedAt) ? b.updatedAt : 0;
  if (au !== bu) return au - bu;
  return String(a.id).localeCompare(String(b.id));
}

export async function listBoards(sdk) {
  await ensureNormalized(sdk);
  const entries = await scanBoards(sdk);
  return entries.map((e) => e.board).sort(compareBoardOrder);
}

/* ------------------------------------------------------------------ *
 * Writing
 * ------------------------------------------------------------------ */

/**
 * Write atomically: a temp file in the same directory, then a rename.
 *
 * A direct write can be interrupted half way and leave an unparseable board; a
 * rename within one filesystem is atomic, so readers see either the old file or
 * the new one.
 *
 * `filename` is explicit for a create or a rename. Omitted, it is the board's
 * current name — and for a board with no file yet, a free name derived from the
 * title, so `createBoard` and the migration need no special casing.
 */
async function writeFileAtomic(sdk, board, filename) {
  const dir = boardsDir(sdk);
  await fs.mkdir(dir, { recursive: true });

  let name = filename;
  if (!name) {
    name = fileIndex.get(board.id) ?? null;
    if (!name) {
      const taken = new Set((await listFilenames(sdk)).map(nameKey));
      name = freeName(filenameForTitle(board.title, board.id), taken);
    }
  }

  const target = fullPath(sdk, name);
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  try {
    // Pretty-printed on purpose: these are files the user can open, diff and read.
    await fs.writeFile(tmp, `${JSON.stringify(toFile(board), null, 2)}\n`, "utf8");
    await fs.rename(tmp, target);
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
  fileIndex.set(board.id, name);
  return name;
}

/**
 * Tell the pages something changed.
 *
 * Sent for **every** write, the agent's and the user's alike. It used to be sent
 * only for the agent's, to avoid a page repainting itself from disk while the
 * user was mid-stroke. That reason is gone: `pullRemote` returns early when the
 * revision has not moved, so a page's own save comes back and does nothing.
 *
 * The cost of not sending it was real and quiet: board content lives in files,
 * which fire no host event, so with an agent-only signal a second open whiteboard
 * window never learned that the first one had saved. Two windows on the same
 * board drifted apart, and the only way back was a manual Sync button — a
 * control the user has to know to look for, for a failure they cannot see.
 *
 * The signal stays content-free: a receiver re-reads what it needs and compares
 * revisions, which remains correct even if the host coalesces several signals
 * into one. It carries the revision it belongs to, so a receiver can skip its own
 * without fetching the whole scene first.
 */
async function signalChange(sdk, board, extra = {}) {
  try {
    await sdk.storage.global.set(PULSE_KEY, { at: Date.now(), boardId: board.id, rev: board.rev, ...extra });
  } catch (err) {
    console.warn("[excalidraw] change signal failed:", err?.message || err);
  }
}

function buildBoard(id, prev, scene, updatedBy) {
  const now = Date.now();
  const board = {
    id,
    title: prev?.title || "白板",
    rev: (prev?.rev || 0) + 1,
    updatedAt: now,
    createdAt: Number.isFinite(prev?.createdAt) ? prev.createdAt : now,
    updatedBy: updatedBy === "agent" ? "agent" : "user",
    scene: {
      type: "excalidraw",
      version: 2,
      source: "hana-excalidraw",
      appState: pickAppState(scene?.appState),
      elements: Array.isArray(scene?.elements) ? scene.elements : [],
    },
  };
  if (Number.isFinite(prev?.order)) board.order = prev.order;
  return board;
}

/**
 * Compare-and-set write. `baseRev` of `null` means "I know I am stale and I am
 * deliberately overwriting anyway" — that is the explicit user choice, never a
 * default.
 */
export async function commitBoard(sdk, id, scene, updatedBy, baseRev) {
  return serialize(id, async () => {
    const prev = await readBoard(sdk, id);
    const currentRev = prev?.rev || 0;
    if (baseRev !== null && baseRev !== currentRev) {
      return { conflict: true, currentRev, board: prev };
    }
    const board = buildBoard(id, prev, scene, updatedBy);
    // A write that does not change the drawing is not a new revision.
    //
    // The card's autosave fires on *every* Excalidraw change, including ones that
    // do not touch the drawing at all — panning, zooming, selecting. Those arrive
    // here as a scene identical to what is already stored. Writing it anyway cost
    // a revision, a file rewrite and a change signal for nothing, and the revision
    // is what other windows use to decide whether they are behind: a look-around
    // in one window made the other window's carefully-held base revision look
    // stale, and it was told it had lost a race it was never in.
    if (
      prev &&
      sceneContentSignature(prev.scene?.elements, prev.scene?.appState) ===
        sceneContentSignature(board.scene.elements, board.scene.appState)
    ) {
      return { conflict: false, currentRev, board: prev, unchanged: true };
    }
    await writeFileAtomic(sdk, board);
    await signalChange(sdk, board);
    // `created` is false for every write that landed on a file that was already
    // there, and true only for the one case where this call brought a board
    // into existence. The card needs it: "overwrite" against a board that has
    // since been deleted would otherwise quietly recreate the file, and the
    // caller would be told it saved onto something that no longer existed.
    return { conflict: false, currentRev, board, created: !prev };
  });
}

/** Last-writer-wins write, used by the card's own debounced autosave. */
export async function writeBoard(sdk, id, scene, updatedBy) {
  return commitBoard(sdk, id, scene, updatedBy, null);
}

/* ------------------------------------------------------------------ *
 * File-level operations: create, rename, delete, reorder
 * ------------------------------------------------------------------ */

const emptyScene = () => ({
  type: "excalidraw",
  version: 2,
  source: "hana-excalidraw",
  appState: pickAppState({ viewBackgroundColor: "#ffffff" }),
  elements: [],
});

/** Create an empty board. Refuses to replace an existing id. */
export async function createBoard(sdk, { id, title } = {}) {
  const boardId = isSafeBoardId(id) ? id : newBoardId();
  // Shares the order queue with moveBoard: both rewrite every board's position.
  return serialize("__order__", async () => {
    await ensureNormalized(sdk);
    const prev = await readBoard(sdk, boardId);
    if (prev) return { created: false, existing: true, board: prev };
    const now = Date.now();
    const board = {
      id: boardId,
      title: cleanTitle(title),
      rev: 1,
      createdAt: now,
      updatedAt: now,
      updatedBy: "user",
      scene: emptyScene(),
    };
    const name = await writeFileAtomic(sdk, board);
    // Pin every position, so the new file lands last and stays there.
    await persistOrder(sdk, await listBoards(sdk));
    // A new file is a change the panel's list has to hear about, and
    // `persistOrder` above rewrites every *other* board without a scene change,
    // so this is the only signal a create produces.
    await signalChange(sdk, board);
    return {
      created: true,
      existing: false,
      filename: name,
      board: (await readBoard(sdk, boardId)) ?? board,
    };
  });
}

/**
 * Rename a board: retitle it and move the file to match.
 *
 * Does not bump `rev`. The revision is the scene version every open card compares
 * against for compare-and-set; moving it on a title change would invalidate the
 * base revision of a card that is mid-edit and turn a rename into a save conflict.
 *
 * The new file is written *before* the old one is removed. An interruption then
 * leaves two files for one board — a duplicate, which `scanBoards` resolves — 
 * rather than no file at all.
 */
export async function renameBoard(sdk, id, title) {
  return serialize(id, async () => {
    const prev = await readBoard(sdk, id);
    if (!prev) return { missing: true };
    const board = { ...prev, title: cleanTitle(title) };
    const current = await resolveFilename(sdk, id);
    const desired = filenameForTitle(board.title, id);

    if (current && nameKey(current) === nameKey(desired)) {
      // Title changed only in characters the filename cannot carry (say, a
      // trailing space). Rewrite the metadata, keep the name.
      await writeFileAtomic(sdk, board, current);
      await signalChange(sdk, board);
      return { board, filename: current, renamed: false };
    }

    const taken = new Set((await listFilenames(sdk)).map(nameKey));
    taken.delete(nameKey(current ?? "")); // freeing itself is not a collision
    const next = freeName(desired, taken);
    await writeFileAtomic(sdk, board, next);
    if (current && current !== next) {
      await fs.rm(fullPath(sdk, current), { force: true });
    }
    // The panel's list is built from titles, and a rename moves the file, so
    // without this the list keeps showing the old name until something else
    // happens to write. Carries the unchanged `rev` on purpose: the page's
    // pull guard is `rev unchanged -> do not repaint`, which is exactly right
    // here (a rename must not clobber strokes that have not been saved yet).
    await signalChange(sdk, board);
    return { board, filename: next, renamed: true, previousFilename: current };
  });
}

/** Delete a board file. The main board is the fallback every card opens, so it stays. */
export async function deleteBoard(sdk, id) {
  if (id === DEFAULT_BOARD_ID) return { refused: true, reason: "main" };
  if (!isSafeBoardId(id)) return { missing: true };
  return serialize(id, async () => {
    const prev = await readBoard(sdk, id);
    if (!prev) return { missing: true };
    const name = await resolveFilename(sdk, id);
    if (name) await fs.rm(fullPath(sdk, name), { force: true });
    fileIndex.delete(id);
    // A deletion is a change like any other, and the panel's list only
    // refreshes on this signal. Without it the row the agent just deleted
    // stays on screen, and the next click on it is a confusing "no such board".
    // `deleted` is what lets the card holding this board tell "someone removed
    // it" from "someone edited it" — the two produce very different states and
    // the same `boardpulse`.
    await signalChange(sdk, prev, { deleted: true });
    return { deleted: true, board: prev };
  });
}

/**
 * Write a dense position to every board that is not already where it belongs.
 *
 * Assigning positions to *all* of them (not just the one that moved) is what ends
 * the reliance on timestamps: after a single create or move, every file carries
 * an explicit index and the fallbacks never run again. `createdAt` alone cannot
 * do this job — several files created in the same millisecond tie.
 */
async function persistOrder(sdk, boards) {
  for (let i = 0; i < boards.length; i++) {
    if (boards[i].order === i) continue;
    const id = boards[i].id;
    // Per-board queue, deliberately: this is a read-modify-write of a whole file,
    // so a scene save landing in the gap would be erased. Running inside that
    // board's own serialize slot is what stops a reorder from eating a save.
    await serialize(id, async () => {
      const fresh = await readBoardRaw(sdk, id);
      if (!fresh || fresh.order === i) return;
      await writeFileAtomic(sdk, { ...fresh, order: i });
    });
  }
}

/**
 * Move a board one position up or down, and persist the resulting order.
 *
 * Order is written as a dense index across every board, so the stored values
 * never drift into an ambiguous state where two files share a position.
 */
export async function moveBoard(sdk, id, direction) {
  const step = direction === "up" ? -1 : direction === "down" ? 1 : 0;
  if (!step) return { refused: true, reason: "direction" };
  return serialize("__order__", async () => {
    const boards = await listBoards(sdk);
    const index = boards.findIndex((b) => b.id === id);
    if (index < 0) return { missing: true };
    const target = index + step;
    if (target < 0 || target >= boards.length) {
      return { moved: false, reason: "edge", index, count: boards.length };
    }
    const next = [...boards];
    [next[index], next[target]] = [next[target], next[index]];
    await persistOrder(sdk, next);
    return { moved: true, index: target, count: next.length, order: next.map((b) => b.id) };
  });
}

/**
 * Move a board to an absolute position.
 *
 * Exists because drag-to-reorder cannot be built on repeated one-step moves.
 * Dragging the first of seven boards to the last slot that way is six sequential
 * requests, each taking the global `__order__` lock and rewriting the order:
 * six chances to stop halfway in a place the user never asked for, no undo, and
 * a sidebar that repaints six times during one gesture. One call that lands
 * where the insertion line was pointing is the whole difference.
 *
 * The `to` is a *request*, not an instruction. It is resolved against the list
 * the backend just read, inside the same lock, and clamped. A stale drag — the
 * list moved under the pointer between the gesture starting and the request
 * landing — therefore lands at the nearest sane slot instead of corrupting the
 * order or writing an id that is not there. What the panel is allowed to say is
 * "around here", never "this is the order".
 *
 * The earlier choice to expose only up/down is not reversed, it is widened: the
 * panel still never sends a full id list, and the backend still owns the order.
 */
export async function moveBoardTo(sdk, id, to) {
  const wanted = Number(to);
  if (!Number.isInteger(wanted)) return { refused: true, reason: "position" };
  return serialize("__order__", async () => {
    const boards = await listBoards(sdk);
    const from = boards.findIndex((b) => b.id === id);
    if (from < 0) return { missing: true };
    // Clamp into range rather than refuse. A drag that overshoots the end of the
    // list should land at the end, not silently do nothing — "nothing happened"
    // is the one outcome the user cannot read.
    const to = Math.max(0, Math.min(wanted, boards.length - 1));
    if (to === from) return { moved: false, reason: "already-there", index: from, count: boards.length };
    const next = [...boards];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    await persistOrder(sdk, next);
    return { moved: true, from, index: to, count: next.length, order: next.map((b) => b.id) };
  });
}

/* ------------------------------------------------------------------ *
 * One-time migration and filename normalization
 * ------------------------------------------------------------------ */

/**
 * Move any `board:<id>` records out of `ctx.storage` into individual files, then
 * make every filename match its title.
 *
 * Runs once per `dataDir`, inside a queue: `listBoards` is called from several
 * routes, and two concurrent scans would both try to write the same files. The
 * flag is keyed by directory rather than being a single process-wide boolean —
 * a boolean silently skips a second store, which is how this was first written.
 *
 * Two safety rules:
 *   - a legacy record is only removed from storage after its file is written, so
 *     an interrupted migration loses nothing and resumes on the next call;
 *   - a file already on disk wins over a leftover record, because it is the newer
 *     medium and overwriting it would lose whatever it holds.
 */
const normalizedDirs = new Set();

export async function ensureNormalized(sdk) {
  const dir = boardsDir(sdk);
  if (normalizedDirs.has(dir)) return { migrated: false, alreadyDone: true };
  return serialize(`__migrate__:${dir}`, async () => {
    if (normalizedDirs.has(dir)) return { migrated: false, alreadyDone: true };

    /* ---- 1. legacy storage records -> files ---- */
    let migrated = 0;
    try {
      const all = await sdk.storage.global.getAll();
      const entries = all?.entries && typeof all.entries === "object" ? all.entries : all || {};
      const legacy = Object.entries(entries).filter(
        ([key, value]) =>
          key.startsWith(BOARD_PREFIX) &&
          value &&
          typeof value === "object" &&
          typeof value.id === "string" &&
          value.scene,
      );
      for (const [key, record] of legacy) {
        const id = record.id;
        if (!isSafeBoardId(id)) continue;
        // Raw read on purpose: using `readBoard` here would re-enter the
        // migration, which is the thing running.
        if (!(await readBoardRaw(sdk, id))) {
          await writeFileAtomic(sdk, {
            id,
            title: typeof record.title === "string" ? record.title : id,
            order: Number.isFinite(record.order) ? record.order : undefined,
            rev: Number.isFinite(record.rev) ? record.rev : 1,
            createdAt: Number.isFinite(record.createdAt) ? record.createdAt : record.updatedAt,
            updatedAt: Number.isFinite(record.updatedAt) ? record.updatedAt : Date.now(),
            updatedBy: record.updatedBy === "agent" ? "agent" : "user",
            scene: record.scene,
          });
        }
        await sdk.storage.global.delete(key);
        migrated++;
      }
    } catch (err) {
      console.warn("[excalidraw] legacy storage read failed:", err?.message || err);
    }
    if (migrated) console.info(`[excalidraw] migrated ${migrated} board(s) into ${dir}`);

    /* ---- 2. filenames follow titles ---- */
    const renamed = [];
    const entries = await scanBoards(sdk);
    const taken = new Set((await listFilenames(sdk)).map(nameKey));
    for (const { board, name } of entries) {
      const desired = filenameForTitle(board.title, board.id);
      if (nameKey(name) === nameKey(desired)) continue;
      taken.delete(nameKey(name));
      const next = freeName(desired, taken);
      taken.add(nameKey(next));
      // Written before the old file is removed, so an interruption duplicates
      // rather than loses. `scanBoards` resolves the duplicate by recency.
      await writeFileAtomic(sdk, board, next);
      await fs.rm(fullPath(sdk, name), { force: true });
      renamed.push(`${name} -> ${next}`);
    }
    if (renamed.length) console.info(`[excalidraw] renamed ${renamed.length} board file(s):`, renamed.join(", "));

    normalizedDirs.add(dir);
    return { migrated: migrated > 0, count: migrated, renamed: renamed.length };
  });
}

/** Kept as the old name so callers and tests from the storage era keep working. */
export const ensureMigrated = ensureNormalized;
