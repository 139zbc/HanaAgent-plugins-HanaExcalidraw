import {
  createBoard,
  DEFAULT_BOARD_ID,
  commitBoard,
  deleteBoard,
  listBoards,
  readBoard,
  renameBoard,
} from "./boardStore.js";
import { compactScene, expandScene, sceneStats } from "./boardFormat.js";
import { checkScene, summarizeCheck } from "./boardCheck.js";
import { MAX_EDGES, MAX_TEXT_SIZE, requestConversion, suggestTitle, validateMermaid } from "./mermaid.js";
import { DEFAULT_RENDER_TIMEOUT_MS, requestRender } from "./render.js";
import { SHARED_BOARD_KEY } from "./storageKeys.js";

/**
 * Agent-facing tools.
 *
 * Two contracts learned the hard way and now written into the code:
 *
 * 1. A tool's return value must carry `content` as a block array, e.g.
 *    `{ content: [{ type: "text", text: "..." }] }`. Returning a bare object
 *    works fine in a test and comes back to the model as literally nothing —
 *    "Tool ran without output or errors". `details` is optional and never
 *    shown to the model.
 *
 * 2. The model reads and writes the compact form from boardFormat.js. A full
 *    scene is ~530 bytes per element of paint and bookkeeping; the short form is
 *    roughly a third of that, and it makes the model far less likely to rewrite
 *    a `seed` it should have left alone.
 */

const reply = (text, details) => ({ content: [{ type: "text", text }], details });

/**
 * Record what the invocation actually carried, to a key that can be read off disk.
 *
 * The tool's reply already reports this, but a reply can be missed or truncated,
 * and this is the question that decides whether a design is viable at all. Storage
 * is the same evidence channel the panel probe uses (开发记录: `ui:panelProbe`).
 *
 * Values are never written — only key names and string lengths. A callToken is a
 * credential.
 */
async function recordProbe(sdk, record) {
  try {
    await sdk.storage.global.set("ui:shareProbe", { at: Date.now(), ...record });
  } catch (err) {
    console.warn("[excalidraw] share probe write failed:", err?.message || err);
  }
}

function normalizeArgs(args) {
  if (args == null) return {};
  if (typeof args === "object" && !Array.isArray(args)) return args;
  if (typeof args === "string") {
    const text = args.trim();
    if (!text) return {};
    try {
      const parsed = JSON.parse(text);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return {};
}

/**
 * Agent arguments reach `execute` in more than one shape depending on the
 * channel. The model loop hands over real JSON; the agent-facing `tool_call`
 * bridge serializes the whole argument object and flattens arrays into
 * columnar objects on the way. Observed, not theorized:
 *   - a JSON array of elements arrived as `{t:[...], x:[...], s:[...]}`;
 *   - a number arrived as the string "66";
 *   - a plain string always survived intact.
 * So the schema accepts both forms and the payload is normalized here. A tool
 * that only accepts the tidy shape works in exactly one of two places.
 */
function coerce(value) {
  if (typeof value !== "string") return value;
  const text = value.trim();
  if (!text) return value;
  if (text[0] === "[" || text[0] === "{") {
    try {
      return JSON.parse(text);
    } catch {
      return value;
    }
  }
  const n = Number(text);
  return Number.isFinite(n) ? n : value;
}

function resolveId(args) {
  const raw = coerce(args.boardId);
  return typeof raw === "string" && raw.trim() ? raw.trim() : DEFAULT_BOARD_ID;
}

const COMPACT_SCHEMA = {
  id: "string，必填且唯一。修改已有元素时沿用原 id，这样笔迹和图层才会保持不变。",
  t: "string，必填。type：rectangle | ellipse | diamond | arrow | line | text",
  x: "number，必填。左上角坐标，用 .5 结尾像素对齐。",
  y: "number，必填。",
  w: "number，必填。宽度（arrow 会被 pts 自动算出，可填 0）。",
  h: "number，必填。高度（同上）。",
  s: "string，可选。描边色。",
  bg: "string，可选。填充色。",
  text: "string，仅 text 元素必填。",
  fs: "number，可选。字号，默认 20。",
  pts: "array，仅 arrow/line 必填。形如 [[0,0],[0,90]]，首点必须是 [0,0]。",
  dash: 'string，可选。"dashed" 表示返回/异步/回环。',
  head: "string，可选。箭头头部，arrow 默认 \"arrow\"。",
  op: "number，可选。透明度 0-100。",
  clean: "boolean，可选。true 表示直线（roughness 0）。",
};

/**
 * Post the board into the conversation as an in-flow preview card.
 *
 * `session:send-custom` is the door; `contributes.messageRenderers` maps the
 * customType onto our own routed card. Two deliberate choices:
 *
 *   - `triggerTurn: false`. The preview is something the user reads, not an
 *     instruction to the model. The capability doc says an idle session with an
 *     explicit false never consults `app/session.start-turn`, so this does not
 *     need a new grant and cannot spend the user's quota.
 *   - `display: true`, so the host projects it into an ordinary plugin_card
 *     instead of burying it in the raw protocol stream.
 *
 * The host does not forward the payload into the card iframe: the card reads the
 * same backend route on its own, which is why the preview needs no extra state.
 */
export function registerBoardShare(sdk) {
  return [
    {
      name: "board_share",
      description:
        "把当前白板投影成聊天里的一张只读预览卡，让用户在不离开对话的情况下看到你画的图。" +
        "画完之后调用，用户想看图或者想在对话里留档时才用。",
      parameters: {
        type: "object",
        properties: {
          boardId: { type: "string", description: "场景 id，省略则为主画板 main。" },
          note: { type: "string", description: "可选，卡片上显示的一句话说明。" },
        },
        additionalProperties: false,
      },
      async execute(args) {
        const input = normalizeArgs(args);
        const id = resolveId(input);
        const board = await readBoard(sdk, id);
        if (!board) {
          return reply(`场景 ${id} 还不存在，先 board_write 画点什么再分享。`, { ok: false });
        }
        const s = sceneStats(board.scene.elements);
        if (!s.count) {
          return reply(`场景 ${id} 是空的，画完再分享吧。`, { ok: false });
        }

        const note = typeof input.note === "string" ? input.note.trim() : "";

        /**
         * Hand back a card, rather than writing into the conversation.
         *
         * An in-chat stream card is declared **in the tool's own return value**:
         * `details.card`. Three independent sources agree, and the host's own
         * implementation registry states it outright:
         *
         *   "hana/chat.stream.card ... 契约=工具返回值 details.card，不经本 registry"
         *
         * and APPS.md: "聊天流卡走工具调用字面量 details.card：运行时透传".
         *
         * The host then builds a `plugin_card` from it, validating that
         * `pluginId` matches the calling tool's owner — which is us, so it holds.
         * It stamps `sourceStatus`/`cardInstanceId` itself; an author value for
         * those is ignored, so there is nothing to set here.
         *
         * This replaced a `session:send-custom` call, which was the wrong door:
         * that verb exists to put content *into a conversation* (and, mid-stream,
         * to feed it to the model next turn). Showing a picture needs neither, and
         * asking for `app/session.start-turn` to satisfy it would have made
         * "share" mean "make the model talk about what it just shared".
         */
        const card = {
          // Must equal this App's id: the host drops a card whose pluginId is not
          // the tool's owner (`dropping plugin card: claimed pluginId ... !== tool owner`).
          pluginId: "hana-excalidraw",
          type: "iframe",
          // Must be this App's own `ui/` route. `board-preview` is the read-only
          // card declared in the manifest for exactly this purpose.
          route: "/preview.html",
          title: `白板 · ${board.title}`,
        };

        await recordProbe(sdk, {
          outcome: "card-returned",
          boardId: id,
          rev: board.rev,
          count: s.count,
          cardRoute: card.route,
        });

        // Say which board was shared, because the card itself cannot.
        //
        // The route has to keep matching the manifest's declared `route` exactly
        // and the host hands a messageRenderer card no payload, so there is no
        // channel from here into the page. Storage is the one that is left, and
        // it already carries the user's own board choice — the page takes
        // whichever of the two is newer. Without this the preview paints
        // whatever the user happened to be looking at, under a title naming this
        // board.
        try {
          await sdk.storage.global.set(SHARED_BOARD_KEY, { boardId: id, at: Date.now() });
        } catch (err) {
          // Non-fatal: the card still renders, it just falls back to the active
          // board, which is the old behaviour rather than a broken one.
          console.warn("[excalidraw] could not record the shared board:", err?.message || err);
        }

        return reply(
          `已把「${board.title}」作为卡片放进对话（rev ${board.rev}，${s.count} 个图元）。`,
          {
            ok: true,
            via: "details.card",
            boardId: id,
            rev: board.rev,
            card,
            ...(note ? { note } : {}),
          },
        );
      },
    },
  ];
}

export function registerBoardTools(sdk) {
  return [
    ...registerBoardShare(sdk),
    ...registerMermaidTool(sdk),
    ...registerBoardDataTools(sdk),
  ].map((tool) => ({
    ...tool,
    /**
     * Ask for the host convention that mints a `callToken`.
     *
     * The host picks a calling convention from this field, defaulting to
     * `sdk_tool` when it is absent (host source: `(t.invocationStyle ||
     * t.metadata?.hanaInvocationStyle) === "pi_tool" ? "pi_tool" : "sdk_tool"`).
     *
     * That default is what broke `board_share`: the context the tool received
     * carried `sessionPath` but no `callToken`, and `session:send-custom` refuses a
     * bare path — a path *identifies* a session, it does not authorise this app to
     * write into somebody else's conversation ("does not belong to app"). The
     * token is minted on the model-facing convention, which is `pi_tool`.
     */
    invocationStyle: "pi_tool",
    /**
     * Tolerate either argument shape.
     *
     * The v2 door joins tool arguments and the invocation context into one object,
     * which is what these tools are written against. A convention that instead
     * passes positional arguments would hand a tool-call id where arguments are
     * expected — so rather than assume, find the object that is actually ours.
     * Existing behaviour is preserved when the joined object is passed.
     */
    // A named parameter rather than `...args`: keeping `execute.length === 1` leaves
    // the arity signal intact for any dispatcher that reads it, while `arguments`
    // still allows a positional call to be normalised.
    execute: function (args) {
      return tool.execute(normalizeCall(Array.from(arguments)));
    },
  }));
}

/**
 * Pick the argument object out of however this invocation was dispatched.
 *
 * Order matters: the context-bearing object wins, then one carrying any of our
 * own keys, and only then a positional fallback. Returns `{}` rather than
 * throwing, so a malformed call still reaches the tool's own validation and
 * produces a message the model can act on.
 */
function normalizeCall(argsList) {
  const objects = argsList.filter((a) => a && typeof a === "object" && !Array.isArray(a));
  const withContext = objects.find((a) => a.context && typeof a.context === "object");
  if (withContext) return withContext;
  const ourKeys = ["boardId", "note", "id", "title", "elements", "baseRev", "appState"];
  const withOurs = objects.find((a) => ourKeys.some((k) => k in a));
  if (withOurs) return withOurs;
  return objects[0] ?? {};
}

/**
 * Mermaid → Excalidraw elements, as a single tool.
 *
 * This exists because hand-writing element coordinates is the least reliable
 * thing the model does. A flowchart expressed in Mermaid is one short block of
 * text with its own grammar, and Mermaid then produces the geometry — correct
 * spacing, correct edge routing, arrows bound to their shapes, labels bound to
 * both. The alternative, which the other tools still support, is the model
 * computing every x/y and every arrow endpoint itself.
 *
 * The conversion runs in the open card page, not here; see lib/mermaid.js for why
 * that is forced rather than chosen.
 */
function registerMermaidTool(sdk) {
  return [
    {
      name: "board_draw_mermaid",
      description:
        "用 Mermaid 画图。**画流程图、时序图、类图、状态图、ER 图、甘特图等时优先用它**，" +
        "不要手算坐标——Mermaid 会自己排好版，箭头和文字也自动绑定在图形上。" +
        "把图写成 Mermaid 文本即可，例如：flowchart TD 里 A[开始] --> B{对吗}。\n" +
        "**默认会新建一个画板文件**（名字取自 title，没给就按图的内容推一个），**不会动用户已有的任何文件**。" +
        "只有当用户**明确点名**要改哪个画板时（“改一下 xx”、“加到 xx 里”），才传 boardId 写进那个已有画板。" +
        "注意：转换需要浏览器排版，**必须先把白板卡片打开**，否则会等不到回应。" +
        "画完可以用 board_get 看结果（id 由 Mermaid 生成，也可继续用 board_write 手动改）。",
      parameters: {
        type: "object",
        properties: {
          mermaid: {
            type: "string",
            description:
              "Mermaid 图定义。第一行必须是图的类型，如 `flowchart TD` 或 `sequenceDiagram`。" +
              "换行用 \\n。",
          },
          title: {
            type: "string",
            description:
              "新建画板的名字，也是文件名（如“用户注册流程”）。**强烈建议给**：你比语法更清楚这张图在讲什么。" +
              "只在新建时生效。",
          },
          boardId: {
            type: "string",
            description:
              "**只在用户明确要求修改某个已有画板时才传**。省略 = 新建一个文件。" +
              "不确定时不要传——写错文件比多一个文件麻烦得多。",
          },
          mode: {
            type: "string",
            enum: ["append", "replace"],
            description:
              "只在传了 boardId 时才有意义：append（默认）接在已有内容下方；replace 清空后只留这张图。" +
              "新建画板时忽略。",
          },
        },
        required: ["mermaid"],
        additionalProperties: false,
      },
      async execute(args) {
        const input = normalizeArgs(args);
        const checked = validateMermaid(coerce(input.mermaid));
        if (!checked.ok) return reply(checked.error, { ok: false, reason: "invalid-mermaid" });

        const requested = coerce(input.boardId);
        const targetId = typeof requested === "string" && requested.trim() ? requested.trim() : null;
        const mode = coerce(input.mode) === "replace" ? "replace" : "append";

        // Where the diagram goes is the whole point of this shape.
        //
        // Defaulting to `main` meant an agent's diagram landed in whatever the user
        // was working on, and with `mode: replace` it deleted that work (observed,
        // on the first live run — it replaced 36 elements). Drawing a new picture
        // and editing an existing one are different requests, so the tool now does
        // the safe one unless the user named a file.
        let boardId = targetId;
        let created = null;
        if (!boardId) {
          const title = typeof input.title === "string" ? input.title.trim() : "";
          const result = await createBoard(sdk, { title: title || suggestTitle(checked.source) });
          if (!result.created) {
            return reply(
              `新建画板失败（${result.board?.id ?? "未知原因"}）。换一个 title 再试。`,
              { ok: false, reason: "create-failed" },
            );
          }
          boardId = result.board.id;
          created = result.board;
        }

        const conversion = await requestConversion(sdk, {
          boardId,
          mermaid: checked.source,
          // A brand-new board is empty, so "replace" is the honest description of
          // what happens; for an existing one the caller's choice stands.
          mode: created ? "replace" : mode,
        });

        if (!conversion.ok) {
          // A file created for a diagram that never arrived is litter — it would show
          // up in the user's list as an empty entry.
          if (created) {
            try {
              await deleteBoard(sdk, created.id);
            } catch (err) {
              console.warn("[excalidraw] could not clean up empty board:", err?.message || err);
            }
          }
          return reply(
            `Mermaid 画图未完成：${conversion.error}` +
              (created ? `\n（已把刚新建的空画板「${created.title}」删掉，没有留下空文件。）` : ""),
            { ok: false, reason: conversion.reason, token: conversion.token },
          );
        }

        const where = created
          ? `新画板「${created.title}」`
          : `已有画板「${boardId}」`;
        const how = created
          ? "内容是新画的"
          : mode === "replace"
            ? "已清空原有内容"
            : "接在已有内容下方";
        const line =
          `已用 Mermaid 把图写进${where}：${conversion.count} 个图元` +
          (conversion.rev === null ? "" : `，rev ${conversion.rev}`) +
          `（${how}）。`;
        return reply(line, {
          ok: true,
          boardId,
          title: created?.title ?? null,
          createdNewBoard: Boolean(created),
          count: conversion.count,
          rev: conversion.rev,
          mode: created ? "replace" : mode,
          // Stated so the model does not assume the ids are its own.
          note: "图元 id 由 Mermaid 生成，不是 board_write 里的 id。",
        });
      },
    },
  ];
}

function registerBoardDataTools(sdk) {
  return [
    {
      name: "board_list",
      description: "列出白板里所有已保存的场景。只读，不返回图元内容。",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      async execute() {
        const boards = await listBoards(sdk);
        const lines = boards.map((b) => {
          const s = sceneStats(b.scene.elements);
          return `${b.id}  rev ${b.rev}  ${s.count} 个图元  ${JSON.stringify(s.types)}  ${b.updatedBy}  ${new Date(b.updatedAt).toLocaleString("zh-CN")}`;
        });
        return reply(
          lines.length ? lines.join("\n") : "还没有任何场景。用 board_write 画第一个吧。",
          { boards: boards.map((b) => ({ id: b.id, rev: b.rev, ...sceneStats(b.scene.elements) })) },
        );
      },
    },

    {
      name: "board_check",
      description:
        "检查一个画板的结构是否真的对：箭头是否两端都吸在图形上、标签是否真的绑在框里、绑定有没有指向不存在的元素。" +
        "**纯静态检查，不需要打开白板卡片**，也不花钱渲染。\n" +
        "board_write 会自带一次检查；这里是你想单独细看、或别人改过之后复查时用。\n" +
        "它只能判断“结构对不对”，判断不了“好不好看”（挤不挤、文字有没有被裁）—— 后者用 board_render 出图来看。",
      parameters: {
        type: "object",
        properties: {
          boardId: { type: "string", description: "要检查的画板 id，省略则为主画板 main。" },
        },
        additionalProperties: false,
      },
      async execute(args) {
        const input = normalizeArgs(args);
        const id = resolveId(input);
        const board = await readBoard(sdk, id);
        if (!board) return reply(`场景 ${id} 不存在。`, { ok: false, boardId: id });

        const result = checkScene(board.scene.elements);
        const s = sceneStats(board.scene.elements);
        const head =
          `「${id}」 ${s.count} 个图元 ${JSON.stringify(s.types)}：` +
          (result.ok
            ? result.warnings
              ? `${result.warnings} 处可疑（结构没错）`
              : "结构完好"
            : `${result.errors} 处结构错误` + (result.warnings ? `，${result.warnings} 处可疑` : ""));
        const lines = result.findings.map(
          (f, i) => `${i + 1}. [${f.level === "error" ? "错误" : "可疑"}] ${f.message}`,
        );
        return reply([head, ...lines].join("\n"), {
          ok: result.ok,
          boardId: id,
          errors: result.errors,
          warnings: result.warnings,
          // The ids come along so a follow-up `board_write` knows what to touch
          // without re-deriving them from the messages.
          issues: result.findings,
          stats: s,
        });
      },
    },

    {
      name: "board_render",
      description:
        "把画板渲染成一张 PNG 并返回文件路径，供你**真正看一眼自己的图**。\n" +
        "结构对不对用 board_check 就够了；挤不挤、文字有没有被裁、排版好不好看，只能看图。\n" +
        "拿到路径后用普通读文件的工具把那张 PNG 读进来就能看到。\n" +
        "**这一步必须由页面完成**（后端没有画布）：要问一个开着的页面要画布，一个页面都没开就会失败。\n" +
        "**能渲染哪些板，取决于哪种页面开着**——白板页面只持有它当前打开的那一块，渲染别的板得先用 board_share 给那块板开一张预览卡（预览卡能读任意板，不用打断用户）；聊天里已经开着的预览卡也能渲染任何板。\n" +
        "省略 boardId 就渲染白板上当前打开的那张，拿到的是实时画布（live）；指定了别的板则读保存的文件（disk），来源会在结果里告诉你。\n" +
        "一次往返比 board_get 贵得多，画完确认一次就好，不要每笔都跑。",
      parameters: {
        type: "object",
        properties: {
          boardId: {
            type: "string",
            description:
              "要渲染的画板。省略 = 白板上当前打开的那张（实时画布，最省事）。" +
              "要渲染别的板：先用 board_share 给那块板开一张预览卡，再传它的 id。",
          },
        },
        additionalProperties: false,
      },
      async execute(args) {
        const input = normalizeArgs(args);
        const requested = coerce(input.boardId);
        const wanted = typeof requested === "string" && requested.trim() ? requested.trim() : null;
        const result = await requestRender(sdk, { boardId: wanted });
        if (!result.ok) {
          return reply(`渲染未完成：${result.error}`, {
            ok: false,
            reason: result.reason,
            boardId: result.boardId ?? wanted,
          });
        }
        return reply(
          `已渲染「${result.boardId}」：${result.file}` +
            (result.bytes ? `（${Math.round(result.bytes / 1024)} KB）` : "") +
            (result.source === "disk" ? "\n（取自保存的文件，可能不含尚未保存的改动）" : "") +
            `\n用读文件的工具打开这个路径，就能看到图。`,
          {
            ok: true,
            boardId: result.boardId,
            file: result.file,
            bytes: result.bytes ?? null,
            width: result.width ?? null,
            height: result.height ?? null,
            source: result.source ?? null,
          },
        );
      },
    },

    {
      name: "board_create",
      description:
        "新建一个空白画板（新的文件）。返回新的 boardId，之后用它读写。" +
        "同一个话题拆成多张图时用它，而不是把不相干的内容塞进一张。",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "画板名字，会显示在用户的文件列表里。" },
        },
        required: ["title"],
        additionalProperties: false,
      },
      async execute(args) {
        const input = normalizeArgs(args);
        const title = typeof input.title === "string" ? input.title.trim() : "";
        if (!title) return reply("title 必填，它是用户在文件列表里看到的名字。", { ok: false });
        const result = await createBoard(sdk, { title });
        if (!result.created) return reply("这个 id 已经被占用了，换一个名字。", { ok: false });
        return reply(`已新建画板 ${result.board.id}（${result.board.title}）。`, {
          ok: true,
          boardId: result.board.id,
          title: result.board.title,
        });
      },
    },

    {
      name: "board_rename",
      description: "重命名一个已有画板。只改显示名，不影响图元内容。",
      parameters: {
        type: "object",
        properties: {
          boardId: { type: "string", description: "要改名的场景 id。" },
          title: { type: "string", description: "新名字。" },
        },
        required: ["boardId", "title"],
        additionalProperties: false,
      },
      async execute(args) {
        const input = normalizeArgs(args);
        const id = resolveId(input);
        const title = typeof input.title === "string" ? input.title.trim() : "";
        if (!title) return reply("title 必填。", { ok: false });
        const result = await renameBoard(sdk, id, title);
        if (result.missing) return reply(`场景 ${id} 不存在。`, { ok: false });
        return reply(`已把 ${id} 改名为「${result.board.title}」。`, {
          ok: true,
          boardId: id,
          title: result.board.title,
        });
      },
    },

    {
      name: "board_delete",
      description:
        "删除一个白板场景。主画板 main 不能删。删除前先用 board_list 确认它确实是多余的，" +
        "删掉的内容无法恢复。",
      parameters: {
        type: "object",
        properties: { boardId: { type: "string", description: "要删除的场景 id。" } },
        required: ["boardId"],
        additionalProperties: false,
      },
      async execute(args) {
        const input = normalizeArgs(args);
        const id = resolveId(input);
        if (id === DEFAULT_BOARD_ID) {
          return reply("主画板 main 不能删除。", { ok: false });
        }
        const board = await readBoard(sdk, id);
        if (!board) return reply(`场景 ${id} 本来就不存在。`, { ok: true, alreadyGone: true });
        // Goes through boardStore, never the on-disk file: writing app-data by
        // hand is silently rolled back by the host's in-memory copy (开发记录 B2).
        const result = await deleteBoard(sdk, id);
        if (result.refused) return reply("主画板 main 不能删除。", { ok: false });
        const s = sceneStats(board.scene.elements);
        return reply(`已删除场景 ${id}（${s.count} 个图元）。`, { ok: true, boardId: id });
      },
    },

    {
      name: "board_get",
      description:
        "读取一个白板场景的全部图元（紧凑格式）和它的 rev。修改前必须先调用。" +
        "元素字段：id/t/x/y/w/h 必填，s 描边、bg 填充、text 文字、pts 连线点、dash 虚线、fs 字号可选。",
      parameters: {
        type: "object",
        properties: { boardId: { type: "string", description: "场景 id，省略则为主画板 main。" } },
        additionalProperties: false,
      },
      async execute(args) {
        const input = normalizeArgs(args);
        const board = await readBoard(sdk, resolveId(input));
        if (!board) {
          return reply("该场景还不存在，直接 board_write 画第一个。", { board: null });
        }
        const compact = compactScene(board.scene.elements);
        const stats = sceneStats(board.scene.elements);
        return reply(
          `board ${board.id}  rev=${board.rev}  ${stats.count} 个图元  ${JSON.stringify(stats.types)}\n` +
            `appState: ${JSON.stringify(board.scene.appState)}\n\n` +
            `elements:\n${JSON.stringify(compact)}`,
          { boardId: board.id, rev: board.rev, stats },
        );
      },
    },

    {
      name: "board_write",
      description:
        "写入一个白板场景的完整图元列表（紧凑格式），会替换该场景的全部图元。" +
        "要保留用户已经画的内容，必须先 board_get 取回现有 elements，再在列表里带上它们。" +
        "把 baseRev 设成 board_get 读到的 rev；期间若有人改过会被拒绝并返回当前 rev，届时重新读取再改。" +
        "元素格式：id/t/x/y/w/h 必填，s 描边、bg 填充、text 文字、pts 连线点、dash 虚线、fs 字号可选。" +
        "沿用已有元素的 id 可以保持笔迹与图层不变；同 id 重复会被拒绝。" +
        "若调用通道把数组压扁，把整个 elements 列表序列化成 JSON 字符串传进来即可。",
      parameters: {
        type: "object",
        properties: {
          boardId: { type: "string", description: "场景 id，省略则为主画板 main。" },
          elements: {
            type: ["array", "string"],
            description:
              "完整图元列表（不是增量补丁）。某些调用通道会把参数序列化成字符串，" +
              "所以也可以直接传这个列表的 JSON 文本。",
            items: {
              type: "object",
              properties: Object.fromEntries(
                Object.entries(COMPACT_SCHEMA).map(([k, v]) => [k, { type: "string", description: v }]),
              ),
              required: ["id", "t", "x", "y", "w", "h"],
            },
          },
          appState: { type: ["object", "string"], description: "可选，背景色等。" },
          baseRev: {
            type: ["number", "string"],
            description: "来自 board_get 的 rev（数字或字符串皆可）。省略表示强制覆盖。",
          },
        },
        required: ["elements"],
        additionalProperties: false,
      },
      async execute(args) {
        const input = normalizeArgs(args);
        const id = resolveId(input);
        const elements = coerce(input.elements);
        if (!Array.isArray(elements)) {
          return reply(
            `elements 必须是数组或它的 JSON 文本（收到 ${typeof input.elements}）。` +
              "如果调用通道把数组压扁了，请把整个列表序列化成 JSON 字符串再传。",
            { ok: false, receivedType: typeof input.elements },
          );
        }

        const current = await readBoard(sdk, id);
        const live = current?.scene?.elements ?? [];
        let expanded;
        try {
          expanded = expandScene(elements, live);
        } catch (err) {
          return reply(`图元格式有问题，已拒绝写入：${err.message}`, { ok: false, error: err.message });
        }

        const baseRev = coerce(input.baseRev);
        const result = await commitBoard(
          sdk,
          id,
          { elements: expanded, appState: coerce(input.appState) },
          "agent",
          baseRev === undefined || baseRev === null ? null : Number(baseRev),
        );
        if (result.conflict) {
          const s = sceneStats(result.board.scene.elements);
          return reply(
            `写入被拒绝：${id} 当前是 rev ${result.currentRev}，你基于 rev ${baseRev} 修改。\n` +
              `当前有 ${s.count} 个图元。重新 board_get 读最新内容，在它基础上重做修改，然后再写。`,
            { ok: false, conflict: true, currentRev: result.currentRev },
          );
        }
        const s = sceneStats(result.board.scene.elements);
        // Report the scene's own health on the way out.
        //
        // The agent is drawing blind, and the failure that keeps happening is not
        // "the write failed" but "the write succeeded and the picture is wrong" —
        // an arrow whose binding dangles, a label that is not attached to its shape.
        // Checking here costs one pass over elements that are already in memory and
        // turns "画坏了才发现" into "写完就知道".
        const health = checkScene(result.board.scene.elements);
        const summary = summarizeCheck(health);
        return reply(
          `已写入 ${id}  rev ${result.board.rev}  ${s.count} 个图元  ${JSON.stringify(s.types)}` +
            (summary ? `\n⚠ 自检：${summary}。用 board_check 看详情。` : ""),
          {
            ok: true,
            boardId: id,
            rev: result.board.rev,
            stats: s,
            errors: health.errors,
            warnings: health.warnings,
            issues: health.findings,
          },
        );
      },
    },
  ];
}
