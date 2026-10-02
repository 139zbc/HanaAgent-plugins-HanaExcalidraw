import { newBoardId } from "./boardStore.js";

/**
 * Mermaid → Excalidraw, requested by the agent but performed by the page.
 *
 * The conversion cannot run in this process. Mermaid lays out its graph by
 * measuring text in a real document: `parseMermaidToExcalidraw` fails without one
 * (`DOMPurify.addHook is not a function`), and a DOM shim would not help — jsdom
 * reports zero for the `getBBox` measurements the layout depends on, so it would
 * silently produce a diagram with collapsed node sizes. Both steps of the pipeline
 * (`parseMermaidToExcalidraw`, then `convertToExcalidrawElements`) therefore run in
 * the open card page.
 *
 * So this module is a request/response handshake over storage — the same channel
 * the panel and preview probes use:
 *
 *   1. the tool writes `ui:mermaidRequest` and returns to the caller;
 *   2. the page sees it, converts, writes the elements through the existing CAS
 *      route, and records the outcome in `ui:mermaidResult`;
 *   3. the tool polls that result and reports what happened.
 *
 * The page keeps its own single-writer discipline: it commits through the same
 * compare-and-set route as a hand edit, with `updatedBy: "agent"`, so an agent-drawn
 * diagram cannot overwrite a user's stroke by accident.
 *
 * Note the deliberate asymmetry with the page: **reads here are bare values.** The
 * server-side `sdk.storage.global.get` is a direct in-process call and answers the
 * stored value, while the card-side one answers the host's `{ key, value }` wrapper
 * (see `src/storageValue.js` / 开发记录 R57). So `result.token` below is correct
 * as written, and the page needs `unwrapStored` instead — not the other way round.
 */

export const REQUEST_KEY = "ui:mermaidRequest";
export const RESULT_KEY = "ui:mermaidResult";

/** Diagram kinds Mermaid accepts as the first token. Used for a fast, local error. */
const DIAGRAM_KEYWORDS = [
  "flowchart",
  "graph",
  "sequencediagram",
  "classdiagram",
  "statediagram",
  "statediagram-v2",
  "erdiagram",
  "journey",
  "gantt",
  "pie",
  "mindmap",
  "timeline",
  "quadrantchart",
  "xychart",
  "xychart-beta",
  "block",
  "block-beta",
  "sankey",
  "packet",
  "architecture",
  "gitgraph",
  "requirement",
  "c4context",
  "zenuml",
];

/** Above this the layout is slow enough to hang the card; Mermaid's own default. */
export const MAX_TEXT_SIZE = 4000;
/** Edge cap; Mermaid's own default is 1000. */
export const MAX_EDGES = 500;
/** How long the tool waits for the page to answer. */
export const DEFAULT_TIMEOUT_MS = 20000;

/**
 * Cheap static validation, run before anything is asked of the page.
 *
 * It cannot catch a syntax error inside a diagram — only Mermaid can, and only with
 * a DOM. What it does catch is the common, unambiguous mistakes (empty text, a
 * missing diagram keyword, a payload far past the layout budget), so those fail
 * immediately with a message that names the problem instead of after a 20-second
 * wait.
 */
export function validateMermaid(text) {
  const source = typeof text === "string" ? text.trim() : "";
  if (!source) return { ok: false, error: "mermaid 不能为空" };
  if (source.length > MAX_TEXT_SIZE) {
    return { ok: false, error: `mermaid 太长（${source.length} 字符，上限 ${MAX_TEXT_SIZE}）` };
  }
  // A leading `%%` comment line is normal, so skip comment lines before the check.
  const withoutComments = source
    .split(/\r?\n/)
    .filter((line) => !line.trim().startsWith("%%"))
    .join("\n")
    .trim();
  if (!withoutComments) return { ok: false, error: "mermaid 里只有注释，没有图" };
  const first = withoutComments.split(/\s+/)[0].toLowerCase();
  if (!DIAGRAM_KEYWORDS.some((k) => first === k)) {
    return {
      ok: false,
      error:
        `mermaid 第一行要以图的类型开头，收到 "${first}"。` +
        `常用：flowchart TD / sequenceDiagram / classDiagram / stateDiagram-v2 / erDiagram / gantt / pie`,
    };
  }
  return { ok: true, source: withoutComments };
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Diagram kind → a readable Chinese name, used when no title is supplied. */
const KIND_NAMES = {
  flowchart: "流程图",
  graph: "流程图",
  sequencediagram: "时序图",
  classdiagram: "类图",
  statediagram: "状态图",
  "statediagram-v2": "状态图",
  erdiagram: "ER 图",
  journey: "旅程图",
  gantt: "甘特图",
  pie: "饼图",
  mindmap: "思维导图",
  timeline: "时间线",
  quadrantchart: "象限图",
  xychart: "折线图",
  "xychart-beta": "折线图",
  block: "块图",
  "block-beta": "块图",
  sankey: "桑基图",
  packet: "数据包图",
  architecture: "架构图",
  gitgraph: "Git 图",
  requirement: "需求图",
  c4context: "C4 图",
  zenuml: "时序图",
};

/**
 * A name for the board a diagram is about to be written into.
 *
 * Only a fallback: the tool asks the model for a `title` because it knows what the
 * diagram is *about* — "用户注册流程" is a far better file name than anything
 * derivable from the syntax. This exists so that a call without one still lands in
 * a file the user can recognise, rather than in something called "未命名画板".
 *
 * The first bracket label is used when there is one, since a diagram usually opens
 * with its entry step; otherwise the diagram kind. Both are guesses, and both are
 * better than a number.
 */
export function suggestTitle(mermaid, fallback = "Mermaid 图") {
  const source = typeof mermaid === "string" ? mermaid : "";
  const kind = source
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l && !l.startsWith("%%"))
    ?.split(/\s+/)[0]
    ?.toLowerCase();
  const kindName = kind ? KIND_NAMES[kind] : null;

  // `A([开始])`, `B[输入手机号]`, `C{格式正确?}` and `A-->|是| D` all carry a label.
  const bracket = /[[({]+([^\])\}]+?)[\])}]+/.exec(source);
  const branch = /\|\s*([^|]+?)\s*\|/.exec(source);
  const label = (bracket?.[1] ?? branch?.[1] ?? "").replace(/\s+/g, " ").trim();

  // A one-character label is a poor file name ("开" tells nobody anything), and a
  // very long one would be clipped anyway — both fall through to the kind name.
  if (label.length >= 2 && label.length <= 20) return label;
  return kindName ?? fallback;
}

/**
 * Ask the page to convert, and wait for its answer.
 *
 * Every dependency is injectable — the clock, the sleep, and the storage reads —
 * because the waiting logic is the part worth testing and it must not make a test
 * take twenty real seconds.
 *
 * Returns a discriminated result rather than a bare boolean: "no card is open",
 * "the page said the diagram was invalid", and "the page never answered" are three
 * different situations with three different fixes, and collapsing them would leave
 * the caller guessing.
 */
export async function requestConversion(
  sdk,
  { boardId, mermaid, mode = "append", timeoutMs = DEFAULT_TIMEOUT_MS, pollMs = 300 },
  deps = {},
) {
  const now = deps.now ?? (() => Date.now());
  const sleep = deps.sleep ?? defaultSleep;
  const token = deps.token ?? `${now().toString(36)}-${newBoardId()}`;

  const request = { token, boardId, mermaid, mode, at: now() };
  await sdk.storage.global.set(REQUEST_KEY, request);

  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    await sleep(pollMs);
    let result = null;
    try {
      result = await sdk.storage.global.get(RESULT_KEY);
    } catch {
      /* a read failure is retried by the loop, not fatal */
    }
    if (!result || result.token !== token) continue;

    if (result.ok) {
      return { ok: true, token, count: result.count ?? 0, rev: result.rev ?? null };
    }
    return {
      ok: false,
      token,
      reason: result.reason ?? "page-error",
      error: result.error ?? "页面转换失败",
    };
  }

  // Nobody answered. The overwhelmingly likely cause is that the card is not open,
  // since the conversion has no way to run without it — say that, rather than
  // reporting a bare timeout.
  return {
    ok: false,
    token,
    reason: "timeout",
    error:
      `等待 ${Math.round(timeoutMs / 1000)} 秒没有回应。Mermaid 的排版需要浏览器，` +
      `请先打开白板卡片再试。`,
  };
}

/** Clear the handshake keys, so a stale request is not replayed on the next open. */
export async function clearMermaidHandshake(sdk) {
  for (const key of [REQUEST_KEY, RESULT_KEY]) {
    try {
      await sdk.storage.global.delete(key);
    } catch (err) {
      console.warn(`[excalidraw] could not clear ${key}:`, err?.message || err);
    }
  }
}
