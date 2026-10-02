/**
 * Static health check for a board scene.
 *
 * The agent draws blind. It writes elements and gets back "44 图元" — a count,
 * which says nothing about whether those elements are *connected*. Every bad
 * diagram this project has produced failed the same way: it looked plausible as
 * data and was wrong as a picture (开发记录 R17/R18 — floating branch labels, arrows
 * that do not follow the shape they point at).
 *
 * This module is the cheap half of seeing: it reads the scene and reports what is
 * structurally broken. It needs no browser — it is arithmetic over the stored
 * elements — so it works whether or not the card is open.
 *
 * What it deliberately does NOT do: judge whether the diagram is *good*. Nothing
 * here can tell that a box is 3px from its neighbour or that a label is clipped.
 * That is the other half, and it needs a rendered image (`board_render`).
 *
 * The binding contract, which is what most of these checks are about:
 *
 *   arrow  →  startBinding.elementId / endBinding.elementId  →  shape
 *   shape  →  boundElements: [{ id, type: "arrow" }]         →  the same arrow
 *
 * Both directions must exist. A one-way record still renders on first paint and
 * then comes apart the moment someone drags the shape, which is exactly the bug
 * class that reads as "the diagram was fine until I touched it".
 *
 * Findings are split into `error` (structurally broken — the picture is wrong) and
 * `warn` (suspicious, judge it yourself). A check that cries wolf gets ignored, so
 * anything that could be a legitimate choice is a warning at most; the calibration
 * is that the project's own known-good boards must come back with zero errors.
 */

/** Element types that can be the target of a binding. */
const CONTAINERS = new Set(["rectangle", "ellipse", "diamond", "arrow", "line"]);
/** Element types that render a filled area, for the floating-label heuristic. */
const AREAS = new Set(["rectangle", "ellipse", "diamond"]);

/** Cap findings per code so one repeated mistake cannot bury the rest. */
const PER_CODE_LIMIT = 6;
/** Cap the total, so a badly broken board still produces a readable report. */
const TOTAL_LIMIT = 30;

const live = (elements) => (Array.isArray(elements) ? elements : []).filter((e) => e && !e.isDeleted);

const center = (el) => ({ x: el.x + (el.width ?? 0) / 2, y: el.y + (el.height ?? 0) / 2 });

const shortId = (id) => (typeof id === "string" && id.length > 10 ? `${id.slice(0, 8)}…` : String(id));

/** A bound element's own text, when there is one. Used to name things readably. */
function labelOf(el, byId) {
  if (!el) return "";
  const ref = (Array.isArray(el.boundElements) ? el.boundElements : []).find((b) => b?.type === "text");
  const text = ref ? byId.get(ref.id) : null;
  return typeof text?.text === "string" ? text.text.replace(/\n/g, " ").slice(0, 20) : "";
}

/** `"矩形「提示格式错误」"` — enough to find the element without dumping an id. */
function describe(el, byId) {
  if (!el) return "（不存在的元素）";
  const label = labelOf(el, byId);
  const kind = { rectangle: "矩形", ellipse: "椭圆", diamond: "菱形", arrow: "箭头", line: "线", text: "文字" }[el.type] ?? el.type;
  return label ? `${kind}「${label}」` : `${kind}(${shortId(el.id)})`;
}

/**
 * Check a scene. Pure: same input, same findings, no I/O.
 *
 * Returns `{ ok, errors, warnings, findings, stats }` where `ok` means "no errors"
 * — warnings do not fail the check, by design.
 */
export function checkScene(elements) {
  const findings = [];
  const add = (level, code, message, elementId) => {
    findings.push({ level, code, message, ...(elementId ? { elementId } : {}) });
  };

  const all = Array.isArray(elements) ? elements.filter(Boolean) : [];
  const liveEls = live(all);
  const byId = new Map();
  for (const el of liveEls) if (el?.id) byId.set(el.id, el);

  const stats = { total: liveEls.length, byType: {} };
  for (const el of liveEls) stats.byType[el.type] = (stats.byType[el.type] ?? 0) + 1;

  if (!liveEls.length) {
    return {
      ok: false,
      errors: 0,
      warnings: 0,
      findings: [{ level: "error", code: "empty-scene", message: "画板上没有任何图元。" }],
      stats,
    };
  }

  /* ---- 1. duplicate ids -------------------------------------------------- */
  // Two elements sharing an id is unrecoverable: bindings, deletions and updates
  // all address elements by id, so one of the two becomes unreachable.
  const seen = new Map();
  for (const el of all) {
    if (!el?.id) continue;
    seen.set(el.id, (seen.get(el.id) ?? 0) + 1);
  }
  for (const [id, n] of seen) {
    if (n > 1) add("error", "duplicate-id", `id「${shortId(id)}」出现了 ${n} 次，绑定时会指错元素。`, id);
  }

  /* ---- 2. required fields ------------------------------------------------ */
  for (const el of all) {
    if (!el?.id) {
      add("error", "missing-id", `有个 ${el?.type ?? "?"} 元素没有 id。`);
      continue;
    }
    if (!el.type) {
      add("error", "missing-type", `元素「${shortId(el.id)}」没有 type。`, el.id);
    }
  }

  /* ---- 3. boundElements referential integrity --------------------------- */
  // Both directions of every registration. A binding is a claim made by two
  // elements about each other, and a one-sided claim is the bug that reads as "the
  // diagram was fine until I dragged something": the shape records that it owns a
  // label, the label does not record that it belongs to the shape, and the two part
  // ways on the first move.
  //
  // Found by a fixture in the test that expected an error and got none — the check
  // was only ever looking from the child's side (`text-not-reciprocated`,
  // `label-container-mismatch`), so a stale entry on the *container* passed.
  for (const el of liveEls) {
    const bound = Array.isArray(el.boundElements) ? el.boundElements : [];
    for (const ref of bound) {
      if (!ref?.id) continue;
      const target = byId.get(ref.id);
      if (!target) {
        add(
          "error",
          "bound-element-missing",
          `${describe(el, byId)} 登记了一个${ref.type === "text" ? "文字" : "箭头"}（${shortId(ref.id)}），但那个元素不存在。`,
          el.id,
        );
        continue;
      }
      const kind = target.type === "text" || ref.type === "text" ? "text" : "arrow";
      const pointsBack =
        kind === "text"
          ? target.containerId === el.id
          : target.startBinding?.elementId === el.id || target.endBinding?.elementId === el.id;
      if (!pointsBack) {
        add(
          "error",
          "registration-not-mutual",
          `${describe(el, byId)} 登记了${describe(target, byId)}，但对方没回指它（成为单向登记）。` +
            `拖动时会脱节——按 id 重建绑定或重新写一次那个元素。`,
          el.id,
        );
      }
    }
  }

  /* ---- 4. arrows -------------------------------------------------------- */
  for (const arrow of liveEls) {
    if (arrow.type !== "arrow" && arrow.type !== "line") continue;

    if (typeof arrow.width !== "number" || typeof arrow.height !== "number") {
      add("error", "arrow-unmeasured", `${describe(arrow, byId)} 没有 width/height。`, arrow.id);
    }

    const points = Array.isArray(arrow.points) ? arrow.points : null;
    if (points) {
      if (points.length < 2) {
        add("error", "arrow-too-few-points", `${describe(arrow, byId)} 只有 ${points.length} 个点，至少要 2 个。`, arrow.id);
      }
      // Sub-pixel origins are not a defect and are not reported at all.
      //
      // The original check asserted `points[0]` is exactly `[0, 0]`, on the
      // reasoning that Excalidraw always stores the first point at the element
      // origin. That holds for an arrow this app expanded from hand-written
      // coordinates — `expandElement` refuses anything else at write time — and
      // it does not hold for Mermaid, whose `convertToExcalidrawElements` emits
      // `[0, 0.5]`, `[-0.5, 0.5]` and the like on nearly every arrow. The first
      // Mermaid diagram of a session reported fifteen structural errors on a
      // picture that renders perfectly.
      //
      // Rendering adds `points[0]` to `x`/`y`, so the two are used together and
      // a non-zero origin is not itself wrong. What *is* wrong is a large one: a
      // genuine offset means the line was authored somewhere other than where it
      // was placed. So the threshold is the question — is this the shape
      // sub-pixel alignment produces, or a real displacement? Anything within a
      // pixel is the former and stays silent; beyond that it is worth saying.
      //
      // Reporting the sub-pixel case as a warning was tried first and is worse
      // than useless: every Mermaid diagram then opens with "15 处可疑" that a
      // reader cannot act on, and a check that cries wolf is one nobody reads.
      const [x0, y0] = points[0] ?? [];
      const subPixel = Math.abs(Number(x0) || 0) <= 1 && Math.abs(Number(y0) || 0) <= 1;
      if (points.length && (x0 !== 0 || y0 !== 0) && !subPixel) {
        add(
          "warn",
          "arrow-origin-offset",
          `${describe(arrow, byId)} 的起点是 [${x0}, ${y0}]，离 [0, 0] 超过一个像素。` +
            "这种偏移会让线画在它自己的位置之外，检查一下 points 是怎么写的。",
          arrow.id,
        );
      }
    } else if (!arrow.startBinding && !arrow.endBinding) {
      add("warn", "arrow-unbound-free", `${describe(arrow, byId)} 既没有 points 也没有两端绑定，可能不会显示。`, arrow.id);
    }

    // Every declared binding must resolve, and must be reciprocated.
    for (const [side, binding] of [
      ["起点", arrow.startBinding],
      ["终点", arrow.endBinding],
    ]) {
      if (!binding?.elementId) continue;
      const target = byId.get(binding.elementId);
      if (!target) {
        add(
          "error",
          "arrow-dangling-binding",
          `${describe(arrow, byId)} 的${side}绑定指向 ${shortId(binding.elementId)}，那个元素不存在。`,
          arrow.id,
        );
        continue;
      }
      const back = Array.isArray(target.boundElements) ? target.boundElements : [];
      if (!back.some((b) => b?.id === arrow.id)) {
        // The arrow draws attached, then stops following the shape when dragged.
        add(
          "error",
          "arrow-binding-not-reciprocated",
          `${describe(arrow, byId)} 绑到了 ${describe(target, byId)}，但那个${target.type === "arrow" ? "箭头" : "图形"}没有反过来登记它 —— 拖动时箭头会掉队。`,
          arrow.id,
        );
      }
    }

    // A labelled arrow's text is covered by the mutual-registration check in §3,
    // which runs over every binding from both ends — no need to repeat it here.
  }

  /* ---- 5. text elements -------------------------------------------------- */
  for (const text of liveEls) {
    if (text.type !== "text") continue;

    if (typeof text.text !== "string" || !text.text.trim()) {
      add("warn", "empty-text", `有个文字元素是空的（${shortId(text.id)}）。`, text.id);
    }

    if (text.containerId) {
      const container = byId.get(text.containerId);
      if (!container) {
        add(
          "error",
          "text-dangling-container",
          `文字「${String(text.text ?? "").replace(/\n/g, " ").slice(0, 16)}」说自己属于 ${shortId(text.containerId)}，但那个元素不存在。`,
          text.id,
        );
        continue;
      }
      if (!CONTAINERS.has(container.type)) {
        add("warn", "text-container-not-container", `文字挂在了一个 ${container.type} 上，它不能承载文字。`, text.id);
      }
      const back = Array.isArray(container.boundElements) ? container.boundElements : [];
      if (!back.some((b) => b?.id === text.id)) {
        add(
          "error",
          "text-not-reciprocated",
          `文字「${String(text.text ?? "").replace(/\n/g, " ").slice(0, 16)}」属于 ${describe(container, byId)}，但对方没登记它 —— 拖动图形时文字会留下。`,
          text.id,
        );
      }
    }
  }

  /* ---- 6. floating labels ------------------------------------------------ */
  // A text that is not bound, yet sits squarely inside a shape, is usually a label
  // that failed to bind. It renders correctly today and detaches the moment the
  // shape moves, which is why it is worth flagging.
  //
  // The thresholds are set from measurement, not taste. A label written by
  // `bindLabel` is `shape.width - 10` wide (≈0.95 of the host) and centred, so it
  // lands near `offset 0 / cover 0.95`. Measured against this workspace's five real
  // hand-placed annotations, those cover 0.29–0.34 of the host and sit 0.62–0.68
  // off-centre — i.e. deliberately tucked in a corner, not a label at all. Requiring
  // both a centred position and a substantial width keeps the check clear of them,
  // and a check that cries wolf is a check that gets ignored.
  const looseTexts = liveEls.filter((e) => e.type === "text" && !e.containerId);
  const areas = liveEls.filter((e) => AREAS.has(e.type));
  for (const text of looseTexts) {
    const c = center(text);
    const host = areas.find((a) => {
      const w = a.width ?? 0;
      const h = a.height ?? 0;
      if (!(w > 0 && h > 0)) return false;
      const cx = a.x + w / 2;
      const cy = a.y + h / 2;
      const offX = Math.abs(c.x - cx) / (w / 2);
      const offY = Math.abs(c.y - cy) / (h / 2);
      const cover = (text.width ?? 0) / w;
      return offX <= 0.35 && offY <= 0.5 && cover >= 0.5;
    });
    if (host) {
      add(
        "warn",
        "floating-label",
        `文字「${String(text.text ?? "").replace(/\n/g, " ").slice(0, 16)}」落在 ${describe(host, byId)} 里面，但没绑上去。` +
          `现在看着没问题，一拖图形它就会留下。`,
        text.id,
      );
    }
  }

  /* ---- 7. degenerate geometry ------------------------------------------- */
  // Only area shapes. An arrow or line that runs exactly horizontally has
  // `height: 0` and one that runs vertically has `width: 0` — that is the normal
  // case for an axis-aligned segment, not a defect. Measured: this workspace holds
  // 27 such segments and not one zero-area shape, so restricting the check to
  // areas costs nothing and removes all of the noise.
  for (const el of liveEls) {
    if (!AREAS.has(el.type)) continue;
    const w = el.width ?? 0;
    const h = el.height ?? 0;
    if (w <= 0 || h <= 0) {
      add("warn", "degenerate-size", `${describe(el, byId)} 的尺寸是 ${w}×${h}，看不到。`, el.id);
    }
  }

  /* ---- 8. no text at all ------------------------------------------------- */
  // A diagram with shapes but not one label is legal, and also the signature of a
  // conversion that half-failed.
  if (liveEls.length >= 3 && !liveEls.some((e) => e.type === "text")) {
    add("warn", "no-text", `${liveEls.length} 个图元里没有任何文字，如果是流程图，多半是标签没写进去。`);
  }

  /* ---- assemble ---------------------------------------------------------- */
  const errors = findings.filter((f) => f.level === "error");
  const warnings = findings.filter((f) => f.level === "warn");
  return {
    ok: errors.length === 0,
    errors: errors.length,
    warnings: warnings.length,
    findings: capFindings(findings),
    stats,
  };
}

/** Keep at most `PER_CODE_LIMIT` per code, then the total cap. */
function capFindings(findings) {
  const perCode = new Map();
  const kept = [];
  for (const f of findings) {
    const n = perCode.get(f.code) ?? 0;
    if (n >= PER_CODE_LIMIT) continue;
    perCode.set(f.code, n + 1);
    kept.push(f);
  }
  if (kept.length <= TOTAL_LIMIT) return kept;
  return kept.slice(0, TOTAL_LIMIT);
}

/**
 * A one-line summary, for a tool that wants to report health without dumping the
 * whole list. Returns `null` when there is nothing to say.
 */
export function summarizeCheck(result) {
  if (!result || (!result.errors && !result.warnings)) return null;
  const parts = [];
  if (result.errors) parts.push(`${result.errors} 处结构错误`);
  if (result.warnings) parts.push(`${result.warnings} 处可疑`);
  return parts.join("，");
}
