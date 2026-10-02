/**
 * Binding: arrows to shapes, and labels inside shapes.
 *
 * Excalidraw's own focus formula (ray/edge intersection in rotated space) is far
 * too intricate to reimplement, and reimplementing it badly produces arrows that
 * point at nothing. So this module computes an *approximate but correctly
 * signed* focus, and then hands the scene to Excalidraw's `restoreElements` with
 * `repairBindings`, which recomputes the endpoint coordinates with the real
 * formula. The approximation only has to be directionally right.
 *
 * The compact format the model writes never mentions bindings at all:
 *   - a shape carries `label: "输入手机号"` and gets a bound text element;
 *   - an arrow carries `from: "a", to: "b"` and gets both endpoints bound.
 */

const DEFAULT_GAP = 4;

const pt = (x, y) => ({ x, y });

function center(el) {
  return pt(el.x + el.width / 2, el.y + el.height / 2);
}

/**
 * Excalidraw measures a binding's `focus` as a *fraction of the shape*, not a
 * distance: for a rectangle the offset is `-height * focus`, so 0 is the middle
 * of an edge and ±0.5 is a corner. Re-deriving it as a ray/diagonal intersection
 * (as some other implementations do) gives a different quantity and produces
 * arrows that point at nothing. This mirrors the shape of the real formula.
 */
export function computeFocus(shape, endpoint) {
  if (shape.type === "ellipse") {
    const cx = shape.x + shape.width / 2;
    const cy = shape.y + shape.height / 2;
    const dx = (endpoint.x - cx) / (shape.width / 2 || 1);
    const dy = (endpoint.y - cy) / (shape.height / 2 || 1);
    return Math.max(-1, Math.min(1, Math.hypot(dx, dy)));
  }
  const v = (endpoint.y - shape.y) / (shape.height || 1) - 0.5;
  return Math.max(-1, Math.min(1, v));
}

/**
 * Exported: the point where an arrow visually meets a shape, offset by the gap.
 *
 * Solved per shape type, because the bounding-box shortcut overshoots badly on an
 * ellipse: aiming straight down a 180x66 ellipse, the box edge sits ~19px beyond
 * the curve, which reads as a detached arrow with a visible gap.
 */
export function edgeAnchor(shape, toward) {
  const cx = shape.x + shape.width / 2;
  const cy = shape.y + shape.height / 2;
  const a = shape.width / 2;
  const b = shape.height / 2;
  let dx = toward.x - cx;
  let dy = toward.y - cy;
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) return { x: cx, y: cy };
  dx /= len;
  dy /= len;

  let t;
  if (shape.type === "ellipse") {
    t = 1 / Math.sqrt((dx / a) ** 2 + (dy / b) ** 2);
  } else if (shape.type === "diamond") {
    // ray meets the edge joining (a,0) to (0,b): x/a + y/b = 1
    const denom = Math.abs(dx / a) + Math.abs(dy / b);
    t = denom < 1e-9 ? Math.hypot(a, b) : 1 / denom;
  } else {
    t = Math.min(
      Math.abs(dx) < 1e-9 ? Infinity : a / Math.abs(dx),
      Math.abs(dy) < 1e-9 ? Infinity : b / Math.abs(dy),
    );
  }
  const reach = t + DEFAULT_GAP;
  return { x: cx + dx * reach, y: cy + dy * reach };
}

/**
 * Focus measured at the point where the arrow meets the shape, so a connection
 * that lands off-centre (say, into the left edge) records that offset instead of
 * silently reading as centre. `repairBindings` then turns this into the final
 * endpoint with Excalidraw's own formula.
 */
function focusFor(shape, toward) {
  return computeFocus(shape, edgeAnchor(shape, toward));
}

const link = (el, ref) => {
  const list = Array.isArray(el.boundElements) ? [...el.boundElements] : [];
  if (!list.some((b) => b.id === ref.id)) list.push(ref);
  el.boundElements = list;
};

/**
 * Turn `from`/`to` on an arrow into real bindings.
 *
 * Runs as a second pass, after every shape exists, so the arrow can be measured
 * against real geometry instead of the model's guesses.
 */
export function bindArrows(arrows, byId) {
  for (const arrow of arrows) {
    if (arrow.type !== "arrow") continue;
    const from = arrow.__from ? byId.get(arrow.__from) : null;
    const to = arrow.__to ? byId.get(arrow.__to) : null;
    if (!from && !to) continue;

    if (from) {
      const aim = to ? center(to) : pt(arrow.x + arrow.width, arrow.y + arrow.height / 2);
      arrow.startBinding = {
        elementId: from.id,
        focus: focusFor(from, aim),
        gap: DEFAULT_GAP,
      };
      link(from, { id: arrow.id, type: "arrow" });
    }
    if (to) {
      const aim = from ? center(from) : pt(arrow.x, arrow.y + arrow.height / 2);
      arrow.endBinding = {
        elementId: to.id,
        focus: focusFor(to, aim),
        gap: DEFAULT_GAP,
      };
      link(to, { id: arrow.id, type: "arrow" });
    }
  }
  return arrows;
}

/**
 * The width a shape's bound text is laid out in.
 *
 * `bindLabel` assigns it and the scene builder must budget line breaks against
 * exactly the same number, so it lives here rather than being written twice
 * (two copies of one formula drift, and the symptom shows up as text wrapping
 * differently from the height the writer predicted).
 */
export function labelWidth(shape) {
  return Math.max(20, (shape?.width ?? 0) - 10);
}

/**
 * A shape's `label` becomes a real bound text element, so double-clicking the
 * shape edits the text inside it and dragging the shape takes the text along.
 */
export function bindLabel(shape, text) {
  shape.boundElements = Array.isArray(shape.boundElements)
    ? shape.boundElements.filter((b) => b.type !== "text")
    : [];
  link(shape, { id: text.id, type: "text" });
  text.containerId = shape.id;
  text.x = shape.x + 5;
  text.y = shape.y + (shape.height - text.height) / 2;
  text.width = labelWidth(shape);
  text.textAlign = "center";
  text.verticalAlign = "middle";
  text.backgroundColor = "transparent";
  text.strokeWidth = 1;
  text.roundness = null;
  return text;
}

/**
 * An arrow's `label` rides the line: "是" / "否" on a decision branch.
 *
 * Excalidraw has native support for this — its editor puts a bound label at the
 * middle segment's midpoint, and drags the text with the line when you move the
 * arrow. So the whole feature is "give the text a `containerId` pointing at the
 * arrow and register it in `boundElements`". The text is centred on the line's
 * midpoint, which is where Excalidraw's own `getBoundTextElementPosition` would
 * put it, so the label does not jump on the first frame.
 */
export function bindLineLabel(arrow, text) {
  const mid = midPoint(arrow);
  link(arrow, { id: text.id, type: "text" });
  text.containerId = arrow.id;
  text.x = mid.x - text.width / 2;
  text.y = mid.y - text.height / 2;
  text.textAlign = "center";
  text.verticalAlign = "middle";
  // A line passes straight through its own label, so an opaque backing keeps the
  // glyphs readable instead of letting the stroke cut them in half.
  text.backgroundColor = "#ffffff";
  text.strokeWidth = 1;
  text.roundness = null;
  return text;
}

/** Midpoint of a 2-point arrow in absolute scene coordinates. */
function midPoint(arrow) {
  const p = arrow.points?.[0] ?? [0, 0];
  const q = arrow.points?.[arrow.points.length - 1] ?? [0, 0];
  return { x: arrow.x + (p[0] + q[0]) / 2, y: arrow.y + (p[1] + q[1]) / 2 };
}
