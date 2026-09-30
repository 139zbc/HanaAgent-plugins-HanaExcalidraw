/**
 * Compact wire format for scenes.
 *
 * A full Excalidraw element is ~530 bytes across 26 fields, almost all of which
 * are paint and bookkeeping the model has no reason to touch. Handing that to a
 * model burns context for nothing and invites it to "helpfully" rewrite a seed.
 *
 * So the model reads and writes a short form, and this module does the
 * translation. Two rules matter:
 *   - expanding an element that already exists must preserve every field the
 *     compact form does not mention (seed, index, version, bindings) — that is
 *     what keeps an edit looking like the same pen stroke instead of a redraw;
 *   - compacting is lossless enough to round-trip what we show the model.
 */

import { bindArrows, bindLabel, bindLineLabel, edgeAnchor } from "./binding.js";

const center = (el) => ({ x: el.x + el.width / 2, y: el.y + el.height / 2 });

const DEFAULTS = {
  angle: 0,
  strokeColor: "#1e1e1e",
  backgroundColor: "transparent",
  fillStyle: "solid",
  strokeWidth: 2,
  strokeStyle: "solid",
  roughness: 1,
  opacity: 100,
  groupIds: [],
  frameId: null,
  isDeleted: false,
  boundElements: null,
  link: null,
  locked: false,
  version: 1,
};

let nonce = 1000000;
const nextNonce = () => ++nonce;

/** Full Excalidraw element -> short form. */
export function compactElement(el, labels) {
  const out = {
    id: el.id,
    t: el.type,
    x: Math.round(el.x * 2) / 2,
    y: Math.round(el.y * 2) / 2,
    w: el.width,
    h: el.height,
  };
  if (labels && labels[el.id]) out.label = labels[el.id];
  if (el.type === "text") {
    out.text = el.text;
    if (el.fontSize && el.fontSize !== 20) out.fs = el.fontSize;
    if (el.fontFamily && el.fontFamily !== 5) out.ff = el.fontFamily;
  }
  if (el.type === "arrow" || el.type === "line") {
    if (el.startBinding) out.from = el.startBinding.elementId;
    if (el.endBinding) out.to = el.endBinding.elementId;
    if (el.strokeStyle && el.strokeStyle !== "solid") out.dash = el.strokeStyle;
  }
  if (el.backgroundColor && el.backgroundColor !== "transparent") out.bg = el.backgroundColor;
  if (el.strokeColor && el.strokeColor !== "#1e1e1e") out.s = el.strokeColor;
  if (el.opacity && el.opacity !== 100) out.op = el.opacity;
  if (el.roughness === 0) out.clean = true;
  return out;
}

export function compactScene(elements) {
  const live = elements.filter((e) => !e.isDeleted);
  const labels = {};
  for (const e of live) {
    if (e.type === "text" && e.containerId && !e.isDeleted) labels[e.containerId] = e.text;
  }
  return live.map((el) => compactElement(el, labels));
}

/**
 * Short form -> full element.
 *
 * `existing` is the live element with that id, when there is one. Everything it
 * already carries is kept unless the compact form explicitly overrides it.
 */
export function expandElement(spec, existing, index) {
  if (!spec || typeof spec !== "object") throw new Error("element must be an object");
  const type = spec.t || spec.type;
  if (!type) throw new Error(`element ${spec.id} has no type`);
  if (!spec.id) throw new Error(`a ${type} element has no id`);

  const base = existing
    ? { ...existing }
    : {
        ...DEFAULTS,
        type,
        id: spec.id,
        seed: Math.abs(hashString(spec.id)) % 2147483647,
        versionNonce: nextNonce(),
        index: index || "a0",
        updated: Date.now(),
        roundness: type === "ellipse" || type === "text" || type === "line" ? null : { type: 3 },
      };

  const next = { ...base, type };
  if (typeof spec.x === "number") next.x = spec.x;
  if (typeof spec.y === "number") next.y = spec.y;
  if (typeof spec.w === "number") next.width = spec.w;
  if (typeof spec.h === "number") next.height = spec.h;
  if (spec.s) next.strokeColor = spec.s;
  if (spec.bg !== undefined) next.backgroundColor = spec.bg;
  if (typeof spec.op === "number") next.opacity = spec.op;
  if (spec.clean) next.roughness = 0;

  if (type === "text") {
    if (spec.text !== undefined) {
      next.text = spec.text;
      next.originalText = spec.text;
    }
    next.fontSize = spec.fs ?? existing?.fontSize ?? 20;
    next.fontFamily = spec.ff ?? existing?.fontFamily ?? 5;
    next.lineHeight = existing?.lineHeight ?? 1.25;
    next.textAlign = existing?.textAlign ?? "center";
    next.verticalAlign = existing?.verticalAlign ?? "middle";
    next.autoResize = existing?.autoResize ?? true;
    if (!existing) {
      next.containerId = null;
      // rough estimate so a fresh text element is clickable at the right size
      const per = (spec.text || "").length;
      next.width = next.width || Math.max(24, per * 18);
      next.height = next.height || Math.round(next.fontSize * 1.25);
    }
  }

  if (type === "arrow" || type === "line") {
    // With from/to the geometry is derived from the two shapes, so the model is
    // not expected to supply points at all; they are computed in a later pass.
    const deferred = Boolean(spec.from || spec.to);
    if (!deferred) {
      if (!Array.isArray(spec.pts) || spec.pts.length < 2) {
        throw new Error(`${spec.id}: pts must be [[0,0],[dx,dy]]（或改用 from/to 声明两端）`);
      }
      if (spec.pts[0][0] !== 0 || spec.pts[0][1] !== 0) {
        throw new Error(`${spec.id}: the first point must be [0,0]`);
      }
    }
    if (spec.pts) {
      next.points = spec.pts;
      const xs = spec.pts.map((p) => p[0]);
      const ys = spec.pts.map((p) => p[1]);
      next.width = Math.max(...xs) - Math.min(...xs);
      next.height = Math.abs(Math.max(...ys) - Math.min(...ys));
    }
    next.startArrowhead = existing?.startArrowhead ?? null;
    next.endArrowhead = spec.head ?? existing?.endArrowhead ?? (type === "arrow" ? "arrow" : null);
    next.lastCommittedPoint = existing?.lastCommittedPoint ?? null;
    next.roundness = existing?.roundness ?? { type: 2 };
    if (spec.dash) next.strokeStyle = spec.dash;
  }

  if (type !== "arrow" && type !== "line" && !next.roundness) {
    next.roundness = { type: 3 };
  }
  return next;
}

/** Expand a whole scene against the live one, keeping untouched elements. */
export function expandScene(specs, liveElements = []) {
  if (!Array.isArray(specs)) throw new Error("elements must be an array");
  const byId = new Map(liveElements.filter((e) => !e.isDeleted).map((e) => [e.id, e]));
  const seen = new Set();

  // Pass 1: shapes, plus the bound label each one asks for. Shapes come first so
  // arrows can be measured against real geometry in pass 2.
  const shapes = [];
  const labels = [];
  const lines = [];
  let n = 0;
  const take = (spec) => {
    if (seen.has(spec.id)) throw new Error(`duplicate id in payload: ${spec.id}`);
    seen.add(spec.id);
    const el = expandElement(spec, byId.get(spec.id), `a${n++}`);
    if (spec.label !== undefined && spec.t !== "arrow" && spec.t !== "line") {
      const text = makeLabel(spec, el);
      seen.add(text.id);
      labels.push(text);
    }
    if (spec.label !== undefined && (spec.t === "arrow" || spec.t === "line")) {
      el.__label = spec.label;
      el.__spec = spec;
    }
    return el;
  };

  for (const spec of specs) {
    if (spec.t === "arrow" || spec.t === "line") continue;
    shapes.push(take(spec));
  }
  for (const spec of specs) {
    if (spec.t !== "arrow" && spec.t !== "line") continue;
    const el = take(spec);
    el.__from = spec.from;
    el.__to = spec.to;
    lines.push(el);
  }

  const all = [...shapes, ...labels, ...lines];
  const index = new Map(all.map((e) => [e.id, e]));
  for (const line of lines) {
    if (line.__from || line.__to) resolveArrow(line, index);
  }
  bindArrows(lines, index);

  // Arrow labels are generated after the geometry settles: the label sits at the
  // line's midpoint, so it cannot be placed until the points are final.
  for (const line of lines) {
    if (line.__label === undefined) continue;
    const text = makeLineLabel({ ...line.__spec, label: line.__label }, line);
    seen.add(text.id);
    all.push(text);
    index.set(text.id, text);
  }
  for (const line of lines) {
    delete line.__from;
    delete line.__to;
    delete line.__label;
    delete line.__spec;
  }
  return all;
}

/** The text that lives inside a shape and moves with it. */
function makeLabel(spec, shape) {
  const existing = (spec.labelElementId && shape.id && null) || null;
  const text = {
    ...DEFAULTS,
    type: "text",
    id: existing || `${shape.id}-t`,
    seed: Math.abs(hashString(`${shape.id}#label`)) % 2147483647,
    versionNonce: nextNonce(),
    updated: Date.now(),
    roundness: null,
    text: String(spec.label),
    originalText: String(spec.label),
    fontSize: spec.lfs ?? (spec.fs ?? 20),
    fontFamily: 5,
    lineHeight: 1.25,
    autoResize: true,
    width: Math.max(24, String(spec.label).length * (String(spec.label).length > 8 ? 16 : 18) + 8),
    height: Math.round((spec.lfs ?? 20) * 1.25),
    strokeColor: spec.lc ?? "#334155",
    angle: 0,
  };
  return bindLabel(shape, text);
}

/**
 * The text that rides an arrow, used for "是" / "否" on a decision branch.
 *
 * `lb` (label background) and `lfs` exist because a branch label sits on top of
 * a line, and the default sizes in `makeLabel` are tuned for text inside a box.
 */
function makeLineLabel(spec, arrow) {
  const str = String(spec.label);
  const fontSize = spec.lfs ?? 16;
  const text = {
    ...DEFAULTS,
    type: "text",
    id: `${arrow.id}-t`,
    seed: Math.abs(hashString(`${arrow.id}#label`)) % 2147483647,
    versionNonce: nextNonce(),
    updated: Date.now(),
    roundness: null,
    text: str,
    originalText: str,
    fontSize,
    fontFamily: 5,
    lineHeight: 1.25,
    autoResize: true,
    // CJK glyphs are square; ASCII is roughly half. A branch label is short, so
    // an exact metric would be noise — this only has to be close enough that the
    // first paint does not shift the box.
    width: Math.max(16, str.length * fontSize + 6),
    height: Math.round(fontSize * 1.25),
    strokeColor: spec.lc ?? "#334155",
    angle: 0,
  };
  return bindLineLabel(arrow, text);
}

/**
 * Place an arrow between two shapes before the bindings are measured.
 *
 * Endpoints go on the *edges*, not the centres: an arrow drawn from centre to
 * centre is hidden under both boxes and never touches a border, which is exactly
 * the "bound but looks unbound" failure. `edgeAnchor` offsets by the same gap
 * the binding declares, so the geometry and the focus agree.
 */
function resolveArrow(arrow, index) {
  const from = arrow.__from ? index.get(arrow.__from) : null;
  const to = arrow.__to ? index.get(arrow.__to) : null;
  if (!from || !to) return; // one end free: keep the coordinates the model gave
  const a = edgeAnchor(from, center(to));
  const b = edgeAnchor(to, center(from));
  arrow.x = a.x;
  arrow.y = a.y;
  arrow.points = [
    [0, 0],
    [b.x - a.x, b.y - a.y],
  ];
  arrow.width = Math.abs(b.x - a.x);
  arrow.height = Math.abs(b.y - a.y);
}

function hashString(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return h;
}

export function sceneStats(elements) {
  const live = elements.filter((e) => !e.isDeleted);
  return {
    count: live.length,
    types: live.reduce((acc, e) => ((acc[e.type] = (acc[e.type] || 0) + 1), acc), {}),
    bytes: JSON.stringify(compactScene(live)).length,
  };
}
