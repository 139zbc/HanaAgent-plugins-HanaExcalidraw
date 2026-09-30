import fs from "node:fs/promises";
import {
  DEFAULT_BOARD_ID,
  commitBoard,
  createBoard,
  deleteBoard,
  listBoards,
  moveBoard,
  moveBoardTo,
  readBoard,
  renameBoard,
  writeBoard,
  isSafeBoardId,
} from "./boardStore.js";

/**
 * Backend HTTP surface for the board card.
 *
 * Public URL: /api/apps/hana-excalidraw/routes/boards...
 * The page reaches this through `hana.api.fetch(path)`, which resolves against
 * that base and carries the surface credential.
 *
 * The card's own autosave uses the last-writer-wins path, because a human
 * dragging a box must never be told they lost a race against themselves. The
 * agent's path goes through CAS and can be refused — that is where losing a
 * race actually matters.
 */
/**
 * Refuse a save whose declared owner disagrees with the path.
 *
 * A page once wrote `main`'s 36 elements into three other boards: the canvas and
 * the requested id could disagree, and nothing checked. The page now tags every
 * draft with its board, but this is the boundary — a mismatch that reaches here
 * is a bug, and losing it is far better than writing it into the wrong file.
 *
 * An absent `boardId` is allowed: older pages and the agent's tool call predate
 * the field, and refusing them would break legitimate writes.
 */
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * What these bytes are, by signature rather than by declaration.
 *
 * `unknown` is a real answer and is never accepted as a match, so a format this
 * function has not been taught cannot slip through by defaulting to success.
 */
function sniff(head, text) {
  if (head.length >= 8 && head.subarray(0, 8).equals(PNG_MAGIC)) return "png";
  const trimmed = text.replace(/^\uFEFF/, "").trimStart();
  if (trimmed.startsWith("<")) return "svg";
  return "unknown";
}

function ownerMismatch(body, pathId) {
  const declared = body?.boardId;
  return typeof declared === "string" && declared !== pathId;
}

export function registerBoardRoutes(app, sdk) {
  app.get("/boards", async (c) => {
    try {
      return c.json({ boards: await listBoards(sdk) });
    } catch (err) {
      return c.json({ error: String(err?.message || err) }, 500);
    }
  });

  // Panel feed and the in-chat preview both need a list that is cheap enough to
  // poll. `listBoards` returns whole scenes, so summarise here instead of making
  // every caller strip 36 elements per board.
  //
  // MUST stay above `/boards/:id`. A parameter route registered first swallows
  // this one — `GET /boards/summary` matches with id="summary", readBoard returns
  // null, and the panel renders its own empty-state text. The symptom reads like
  // "the feature was never built", which is exactly how this cost an hour.
  // A new file starts empty and is titled by the user. The id is minted here so
  // two tabs cannot race to the same "next" name.
  app.post("/boards", async (c) => {
    try {
      const body = await c.req.json().catch(() => ({}));
      const wanted = typeof body?.id === "string" ? body.id : undefined;
      if (wanted && !isSafeBoardId(wanted)) {
        return c.json({ error: "id 只能是 [a-z0-9-_]" }, 400);
      }
      const result = await createBoard(sdk, { id: wanted, title: body?.title });
      if (!result.created) return c.json({ error: "这个 id 已存在", board: result.board }, 409);
      return c.json({ ok: true, board: result.board });
    } catch (err) {
      return c.json({ error: String(err?.message || err) }, 500);
    }
  });

  app.get("/boards/summary", async (c) => {
    try {
      const boards = await listBoards(sdk);
      return c.json({
        boards: boards.map((b) => {
          const els = b.scene?.elements ?? [];
          const live = els.filter((e) => !e.isDeleted);
          const types = {};
          for (const e of live) types[e.type] = (types[e.type] || 0) + 1;
          return {
            id: b.id,
            title: b.title,
            rev: b.rev,
            updatedAt: b.updatedAt,
            updatedBy: b.updatedBy,
            count: live.length,
            types,
          };
        }),
      });
    } catch (err) {
      return c.json({ error: String(err?.message || err) }, 500);
    }
  });

  app.get("/boards/:id", async (c) => {
    try {
      const board = await readBoard(sdk, c.req.param("id"));
      if (!board) return c.json({ board: null, defaultBoardId: DEFAULT_BOARD_ID });
      return c.json({ board });
    } catch (err) {
      return c.json({ error: String(err?.message || err) }, 500);
    }
  });

  app.put("/boards/:id/scene", async (c) => {
    try {
      const body = await c.req.json();
      if (!body || typeof body !== "object" || !Array.isArray(body.scene?.elements)) {
        return c.json({ error: "scene.elements must be an array" }, 400);
      }
      if (ownerMismatch(body, c.req.param("id"))) {
        return c.json(
          { error: `boardId "${body.boardId}" does not match the path "${c.req.param("id")}"` },
          409,
        );
      }
      const result = await writeBoard(sdk, c.req.param("id"), body.scene, body.updatedBy);
      return c.json({ ok: true, rev: result.board.rev, updatedAt: result.board.updatedAt });
    } catch (err) {
      return c.json({ error: String(err?.message || err) }, 500);
    }
  });

  /**
   * Export sink. The page holds the only canvas in this app, so it rasterizes
   * and hands over a data URL; the backend's job is to put bytes on disk under
   * the app's own dataDir. `data:` parsing is done by hand because a string split
   * at the first comma is the whole format — base64 or otherwise.
   *
   * The declared format is checked against the payload's own signature before
   * anything is written. A `.svg` file whose bytes were a PNG shipped once, and a
   * mislabelled file is worse than a refused export: the user finds out later,
   * when the file will not open. This is the boundary, so the check lives here as
   * well as in the page.
   */
  app.post("/boards/:id/export", async (c) => {
    try {
      const body = await c.req.json();
      const format = body?.format === "svg" ? "svg" : "png";
      const dataUrl = typeof body?.dataUrl === "string" ? body.dataUrl : "";
      const match = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(dataUrl);
      if (!match) return c.json({ error: "dataUrl 格式不对" }, 400);
      const isBase64 = Boolean(match[2]);
      const payload = match[3] || "";
      const bytes = isBase64
        ? Buffer.from(payload, "base64")
        : Buffer.from(decodeURIComponent(payload), "utf8");
      if (!bytes.length) return c.json({ error: "导出的文件是空的" }, 400);

      // Decide the type from the bytes, then require it to agree with `format`.
      const actual = sniff(
        bytes.subarray(0, 64),
        bytes.subarray(0, 512).toString("utf8"),
      );
      if (actual !== format) {
        return c.json(
          {
            error: `导出内容与格式不符：声明 ${format}，实际是 ${actual}`,
            format,
            actual,
            bytes: bytes.length,
          },
          415,
        );
      }

      const dir = `${sdk.dataDir.replace(/[\\/]+$/, "")}/exports`;
      await fs.mkdir(dir, { recursive: true });
      const id = String(c.req.param("id")).replace(/[^a-zA-Z0-9_-]/g, "_");
      // Millisecond resolution, plus a collision check.
      //
      // Second resolution silently overwrote: exporting twice within one second
      // (very easy — PNG then SVG) produced one file. An export must never
      // destroy an earlier export, so a taken name gets a numeric suffix.
      const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 23);
      let file = `${dir}/${id}-${stamp}.${format}`;
      for (let n = 2; n < 1000; n++) {
        try {
          await fs.access(file);
          file = `${dir}/${id}-${stamp} (${n}).${format}`;
        } catch {
          break; // free
        }
      }
      await fs.writeFile(file, bytes);
      return c.json({ ok: true, file, format, bytes: bytes.length });
    } catch (err) {
      return c.json({ error: String(err?.message || err) }, 500);
    }
  });

  // Rename. Deliberately does not touch `rev`: the revision is the scene
  // version a card compares against for compare-and-set, and moving it on a
  // title change would turn a rename into a save conflict (see boardStore.js).
  app.put("/boards/:id/meta", async (c) => {
    try {
      const id = c.req.param("id");
      const body = await c.req.json().catch(() => ({}));
      if (typeof body?.title !== "string") {
        return c.json({ error: "title must be a string" }, 400);
      }
      const result = await renameBoard(sdk, id, body.title);
      if (result.missing) return c.json({ error: "没有这个场景" }, 404);
      return c.json({ ok: true, board: result.board });
    } catch (err) {
      return c.json({ error: String(err?.message || err) }, 500);
    }
  });

  // Reorder. Either one step (`up` / `down`) or an absolute slot (`to`).
  //
  // `to` is a *request* for a position, not an order: the backend resolves it
  // against the list it just read, inside the order lock, and clamps. A drag
  // whose list moved under the pointer lands at the nearest sane slot instead of
  // writing something impossible. `up`/`down` is kept because the context menu's
  // 上移 / 下移 are one keystroke cheaper than a drag and the only path that
  // works from the keyboard.
  app.post("/boards/:id/move", async (c) => {
    try {
      const body = await c.req.json().catch(() => ({}));
      if (body?.to !== undefined && body?.to !== null) {
        const result = await moveBoardTo(sdk, c.req.param("id"), body.to);
        if (result.missing) return c.json({ error: "没有这个场景" }, 404);
        return c.json({ ok: true, ...result });
      }
      const direction = body?.direction === "up" ? "up" : body?.direction === "down" ? "down" : null;
      if (!direction) return c.json({ error: "需要 direction（up|down）或 to（位置）" }, 400);
      const result = await moveBoard(sdk, c.req.param("id"), direction);
      if (result.missing) return c.json({ error: "没有这个场景" }, 404);
      return c.json({ ok: true, ...result });
    } catch (err) {
      return c.json({ error: String(err?.message || err) }, 500);
    }
  });

  app.delete("/boards/:id", async (c) => {
    try {
      const id = c.req.param("id");
      const result = await deleteBoard(sdk, id);
      if (result.refused) return c.json({ error: "主画板不能删除" }, 400);
      if (result.missing) return c.json({ ok: true, alreadyGone: true });
      return c.json({ ok: true, id });
    } catch (err) {
      return c.json({ error: String(err?.message || err) }, 500);
    }
  });

  // Agent-facing CAS write. A stale baseRev is refused with the current board
  // so the model can rebase or ask, rather than silently erasing a drawing.
  app.put("/boards/:id/scene/cas", async (c) => {
    try {
      const body = await c.req.json();
      if (!body || !Array.isArray(body.scene?.elements)) {
        return c.json({ error: "scene.elements must be an array" }, 400);
      }
      if (ownerMismatch(body, c.req.param("id"))) {
        return c.json(
          { error: `boardId "${body.boardId}" does not match the path "${c.req.param("id")}"` },
          409,
        );
      }
      const result = await commitBoard(
        sdk,
        c.req.param("id"),
        body.scene,
        body.updatedBy || "agent",
        body.baseRev === undefined ? null : body.baseRev,
      );
      if (result.conflict) {
        return c.json(
          {
            conflict: true,
            error: `board is at rev ${result.currentRev}, you wrote against ${body.baseRev}`,
            currentRev: result.currentRev,
            board: result.board,
          },
          409,
        );
      }
      return c.json({ ok: true, rev: result.board.rev, updatedAt: result.board.updatedAt });
    } catch (err) {
      return c.json({ error: String(err?.message || err) }, 500);
    }
  });
}
