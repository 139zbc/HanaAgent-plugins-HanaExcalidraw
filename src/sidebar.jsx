import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { createPortal } from "react-dom";
import { hana } from "@hana/plugin-sdk";
import {
  ACTIVE_KEY,
  createBoard,
  deleteBoard,
  loadBoardSummary,
  moveBoardTo,
  readActiveBoard,
  renameBoard,
  revealBoard,
  sendBoardCommand,
  subscribeBoardPulse,
  subscribeBoardStatus,
} from "./boardClient.js";
import { connectHost, track } from "./hostBridge.js";
import "./theme-fallback.css";
import "./sidebar.css";

/**
 * The Function Panel, as a document of its own.
 *
 * Declaring `functionPanel.route` makes the host render this page in the panel
 * instead of drawing `hana.panel.set` primitives. That trade is deliberate and
 * one-sided: the vocabulary has no `onContextMenu` and no text field, so a
 * right-click menu on a row and an inline rename box are *not available* on the
 * primitive path, at any version. Everything else here is a transcription of
 * the primitive's own stylesheet and vocabulary, because losing the look while
 * gaining the two capabilities would be paying twice.
 *
 * The split of work with the card:
 *
 *   panel owns  the file list, naming things, reordering, deleting
 *   card  owns  the canvas, switching boards, exporting
 *
 * File operations are plain backend calls, so the panel makes them itself
 * rather than bouncing a request through storage and back. Only the two things
 * that genuinely need the Excalidraw instance — a board swap and an export,
 * which rasterises through a real `<canvas>` — are handed across, on
 * `ui:boardCommand`.
 *
 * The two documents share no JavaScript objects, so the only channel is App
 * storage. Reads are unwrapped: `storage.global.get` answers `{key, value}`, and
 * a field read straight off that envelope is `undefined` every time (开发记录
 * R57 — this exact trap shipped once already).
 */

const $ = (id) => document.getElementById(id);

/** Re-fetching the list on every signal would be fine; this just avoids the pile-up. */
const REFRESH_DEBOUNCE_MS = 120;

const TYPE_LABEL = {
  rectangle: "框",
  ellipse: "椭圆",
  diamond: "判定",
  arrow: "箭头",
  line: "线",
  text: "文字",
  freedraw: "手绘",
};

/** At most two kinds in a row's subtitle; the tail was never readable anyway. */
const MAX_SUBTITLE_TYPES = 2;

function shapeSummary(types = {}) {
  const keys = Object.keys(types);
  if (!keys.length) return "空画板";
  const ranked = keys.sort((a, b) => types[b] - types[a]);
  const head = ranked.slice(0, MAX_SUBTITLE_TYPES).map((k) => `${TYPE_LABEL[k] || k} ${types[k]}`).join(" · ");
  const rest = ranked.length - MAX_SUBTITLE_TYPES;
  return rest > 0 ? `${head} · +${rest}` : head;
}

function ago(ts) {
  if (!ts) return "";
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return "刚刚";
  if (s < 3600) return `${Math.round(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.round(s / 3600)} 小时前`;
  return `${Math.round(s / 86400)} 天前`;
}

/* ------------------------------------------------------------------ *
 * Host theme
 * ------------------------------------------------------------------ */

/**
 * Follow the host theme.
 *
 * Two halves, both necessary. The theme stylesheet is written against
 * `[data-theme="…"]`, and nothing in the page sets that attribute — so even an
 * injected sheet matches nothing. And the SDK only injects the sheet when the
 * theme *changes*, never on first load, even though the first snapshot already
 * carries `cssUrl`. So the first injection has to be done by hand or the panel
 * sits on the fallback colours until the user changes theme once.
 */
function followHostTheme() {
  const STYLE_ATTR = "data-hana-theme-style";
  const inject = async (cssUrl) => {
    if (typeof cssUrl !== "string" || !cssUrl) return;
    try {
      const response = await fetch(cssUrl, { credentials: "same-origin" });
      if (!response.ok) return;
      const css = await response.text();
      let el = document.querySelector(`style[${STYLE_ATTR}]`);
      if (!el) {
        el = document.createElement("style");
        el.setAttribute(STYLE_ATTR, "");
        document.head.appendChild(el);
      }
      el.textContent = css;
    } catch {
      /* A missing theme sheet is not fatal: theme-fallback.css is the floor. */
    }
  };
  const apply = (snapshot) => {
    const id = typeof snapshot?.theme === "string" ? snapshot.theme.trim() : "";
    if (id) document.documentElement.dataset.theme = id;
    void inject(snapshot?.cssUrl);
  };
  try {
    // `subscribe` fires immediately with the current snapshot, so `apply` runs
    // once here and once there. It is idempotent, and doing both is what covers
    // a theme that changed between the two calls.
    apply(hana.theme.getSnapshot());
    hana.theme.subscribe(apply);
  } catch {
    /* No theme surface on this slot: keep the fallback appearance. */
  }
}

/* ------------------------------------------------------------------ *
 * The context menu
 * ------------------------------------------------------------------ */

/**
 * A menu positioned at the pointer, rendered into a fixed layer.
 *
 * The panel itself scrolls (`overflow-y: auto`, straight from the host's own
 * rule), so a menu inside it would be clipped to the list and — worse — would
 * scroll away with it. `position: fixed` plus a portal to the document body is
 * the fix, and it is the reason the menu is a sibling of the panel rather than a
 * child of a row.
 *
 * The two things worth getting right:
 *
 *   - It flips. A 240px menu opened near the bottom of a short panel would
 *     otherwise be half off-screen, and a menu you cannot see is worse than no
 *     menu. Measured against the viewport, not the panel.
 *   - It closes on Escape, on an outside click, and on scroll. The scroll case
 *     matters here specifically: the anchor row moves under the pointer, and a
 *     menu that stays put while its subject walks away now refers to the wrong
 *     board.
 */
function ContextMenu({ at, items, onClose }) {
  const ref = useRef(null);
  const [pos, setPos] = useState({ left: at.x, top: at.y, ready: false });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const pad = 6;
    let left = at.x;
    let top = at.y;
    if (left + rect.width + pad > window.innerWidth) left = Math.max(pad, window.innerWidth - rect.width - pad);
    if (top + rect.height + pad > window.innerHeight) top = Math.max(pad, at.y - rect.height);
    setPos({ left, top, ready: true });
  }, [at]);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    const onDown = (e) => {
      if (ref.current && !ref.current.contains(e.target)) onClose();
    };
    const onScroll = () => onClose();
    window.addEventListener("keydown", onKey, true);
    // Capture, so a click that also lands on a row underneath still closes the
    // menu instead of opening a board behind it.
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onClose);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onClose);
    };
  }, [onClose]);

  useEffect(() => {
    // Focus the first enabled item, so the keyboard is in the menu rather than
    // back on the row that opened it. Without this, Tab walks out of the menu
    // and the first Tab press lands somewhere in the panel.
    const el = ref.current?.querySelector(".bp-menuItem:not(:disabled)");
    el?.focus?.();
  }, []);

  return createPortal(
    <div
      className="bp-menu"
      ref={ref}
      role="menu"
      style={{ left: pos.left, top: pos.top, visibility: pos.ready ? "visible" : "hidden" }}
    >
      {items.map((item) =>
        item.divider ? (
          <div className="bp-menuDivider" key={item.id} role="separator" />
        ) : item.heading ? (
          <p className="bp-menuHeading" key={item.id}>
            {item.label}
          </p>
        ) : (
          <button
            type="button"
            role="menuitem"
            className="bp-menuItem"
            key={item.id}
            data-tone={item.tone}
            disabled={item.disabled}
            onClick={() => {
              onClose();
              item.action?.();
            }}
          >
            {item.label}
          </button>
        ),
      )}
    </div>,
    document.body,
  );
}

/* ------------------------------------------------------------------ *
 * Drag to reorder
 * ------------------------------------------------------------------ */

/**
 * How far the pointer must travel before a press becomes a drag.
 *
 * Euclidean, not per-axis. A drag that starts sideways and curves down is still
 * a drag, and a hand that drifts a few pixels sideways while resting on a handle
 * is not. This is the host's own rule for the same gesture in the session list,
 * and there is no reason for two lists in one app to disagree about it.
 *
 * Without a threshold every click is a potential drag and rows stop switching
 * boards. With too large a one, the row visibly slides before the drag starts.
 */
const DRAG_THRESHOLD_PX = 5;

/**
 * How long a finger must rest before a touch turns into a drag.
 *
 * Touch is the reason the row cannot simply be the drag surface everywhere. The
 * panel scrolls vertically and the rows are a vertical list, so a finger that
 * lands on a row and moves means "scroll" — and no amount of threshold separates
 * that from a drag, because they are the same gesture.
 *
 * The usual answers are a long press or a dedicated handle. The handle was tried
 * first and is worse: it is a 10px strip that does nothing visible, so a touch
 * user either never finds it or hits it and gets silence. A long press is what
 * every phone file manager already does, and its side effect — the insertion line
 * appearing — is its own feedback.
 *
 * A finger that moves before this elapses is a scroll, and is left alone.
 */
const TOUCH_HOLD_MS = 350;

/** How close to the top/bottom edge before the list starts scrolling itself. */
const AUTOSCROLL_EDGE_PX = 28;

/** Per-frame scroll while the pointer is held past an edge. Capped, not raw. */
const AUTOSCROLL_MAX_PX = 10;

/**
 * Which slot the pointer is aiming at.
 *
 * Measured against row midpoints rather than row edges, so the gap between two
 * rows resolves to "after the upper one" — the boundary you would draw at the
 * halfway line, not at the pixel where one row's padding ends. Getting this
 * wrong is the classic off-by-one-row: the drop lands one position from where
 * the line was, and it looks like the list is lying.
 *
 * Returns an insertion index in `0..rows.length`: 0 is above the first row,
 * `rows.length` is below the last.
 */
function slotAt(clientY, rowEls) {
  if (!rowEls.length) return 0;
  if (clientY <= rowEls[0].getBoundingClientRect().top) return 0;
  const last = rowEls[rowEls.length - 1].getBoundingClientRect();
  if (clientY >= last.bottom) return rowEls.length;
  for (let i = 0; i < rowEls.length; i++) {
    const rect = rowEls[i].getBoundingClientRect();
    if (clientY < rect.top + rect.height / 2) return i;
  }
  return rowEls.length;
}

/* ------------------------------------------------------------------ *
 * The panel
 * ------------------------------------------------------------------ */

function Sidebar() {
  const [boards, setBoards] = useState([]);
  const [listError, setListError] = useState("");
  const [activeId, setActiveId] = useState(null);
  const [status, setStatus] = useState({ exporting: "", notice: null });
  const [error, setError] = useState("");
  const [menu, setMenu] = useState(null);
  /** The insertion line, in pixels from the top of the list. */
  const [dropAt, setDropAt] = useState(null);
  /** Which row is being dragged, for the dimmed state. */
  const [draggingId, setDraggingId] = useState(null);
  /** `{ kind: "rename" | "new", boardId?, value }` — the text field, open. */
  const [composer, setComposer] = useState(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef(null);
  const listRef = useRef(null);
  /**
   * The live drag, in a ref rather than state.
   *
   * Pointermove fires far faster than React renders, and a drag that re-renders
   * the whole panel on every move is both janky and a source of stale closures
   * over the row list. Only two things are ever drawn from it: the insertion
   * line's position, and which row is dimmed.
   *
   * The element that captures the pointer is stored rather than captured at
   * `pointerdown`: capture taken before the threshold is crossed is what makes a
   * press swallow the click that was meant to switch boards.
   */
  const dragRef = useRef(null);
  /** Set the instant a drag activates, and read by the row's onClick. */
  const suppressClickRef = useRef(false);
  /**
   * Where the open menu is, readable without making any callback depend on the
   * menu's own state. The delete confirmation re-opens a menu at the same
   * point, and threading that through `menu` would make the handler that builds
   * the menu depend on the menu.
   */
  const menuAtRef = useRef(null);

  /* ---- data ---------------------------------------------------------- */

  const load = useCallback(async () => {
    try {
      const list = await loadBoardSummary();
      setBoards(list);
      setListError("");
    } catch (err) {
      // Kept as a line in the panel rather than an empty list: "no boards" and
      // "could not read the boards" look identical otherwise, and only one of
      // them is fixed by creating a board.
      setListError(String(err?.message || err).slice(0, 120));
      track("panel:list-failed", { message: String(err?.message || err) });
    }
  }, []);

  useEffect(() => {
    connectHost();
    followHostTheme();
    void load();
    readActiveBoard().then(setActiveId);
    return subscribeBoardStatus(setStatus);
  }, [load]);

  /**
   * Re-read the list whenever anything is written.
   *
   * `boardpulse` is the signal the backend emits after every write, whoever made
   * it — so this one subscription covers the user renaming a file, the user
   * deleting one, and the agent creating one through a tool, with no polling and
   * no extra channel.
   */
  useEffect(() => {
    let timer = 0;
    const off = subscribeBoardPulse(() => {
      clearTimeout(timer);
      timer = setTimeout(() => void load(), REFRESH_DEBOUNCE_MS);
    });
    return () => {
      clearTimeout(timer);
      off();
    };
  }, [load]);

  /** Track the current board from the card's writes, not from local guesses. */
  useEffect(() => {
    return hana.storage.global.onChanged((keys) => {
      if (Array.isArray(keys) && keys.includes(ACTIVE_KEY)) {
        readActiveBoard().then(setActiveId);
      }
    });
  }, []);

  /* ---- the two things that need the canvas --------------------------- */

  const openBoard = useCallback(
    (boardId) => {
      setMenu(null);
      void sendBoardCommand({ kind: "switch", boardId });
    },
    [],
  );

  const exportBoard = useCallback((format) => {
    void sendBoardCommand({ kind: "export", format });
  }, []);

  /* ---- file operations ------------------------------------------------ */

  /**
   * A toast, with a way to be seen when there is no toast.
   *
   * `hana.toast` is a host capability, and the failure mode for calling it wrong
   * is the worst kind: a TypeError before anything is sent, so the panel simply
   * did nothing. If it is missing the message still has to land somewhere, and
   * the panel already knows how to print one.
   */
  const toast = useCallback(async (message, type) => {
    try {
      if (typeof hana?.toast?.show === "function") {
        await hana.toast.show({ message, type });
        return true;
      }
    } catch {
      /* fall through to the panel */
    }
    setError(message);
    return false;
  }, []);

  const run = useCallback(
    async (label, fn) => {
      setBusy(true);
      setError("");
      try {
        await fn();
        await load();
      } catch (err) {
        setError(`${label}失败：${String(err?.message || err).slice(0, 80)}`);
        track("panel:file-op-error", { label, message: String(err?.message || err) });
      } finally {
        setBusy(false);
      }
    },
    [load],
  );

  /**
   * Submit the composer.
   *
   * Rename writes the title and stops there. Create mints an id on the backend
   * and then *switches to it*, because a board you just named is the one you
   * are about to draw on — the old behaviour, kept deliberately: creating and
   * then staring at the old board is a small betrayal.
   */
  const submitComposer = useCallback(() => {
    if (!composer || busy) return;
    const value = (composer.value || "").trim();
    if (!value) {
      setError("名字不能为空");
      return;
    }
    if (composer.kind === "rename") {
      const { boardId } = composer;
      setComposer(null);
      void run("重命名", async () => {
        await renameBoard(boardId, value);
        track("board:renamed", { boardId, title: value, via: "panel" });
      });
      return;
    }
    setComposer(null);
    void run("新建", async () => {
      const res = await createBoard({ title: value });
      if (res?.board?.id) {
        await sendBoardCommand({ kind: "switch", boardId: res.board.id });
        track("board:created", { boardId: res.board.id, title: value, via: "panel" });
      }
    });
  }, [composer, busy, run]);

  const removeBoard = useCallback(
    (boardId) => {
      void run("删除", async () => {
        // Land the canvas on the row that slides into the gap, decided off the
        // list as the user last saw it — the same reasoning the card used: the
        // row their eye is already on, rather than whatever used to be first.
        const at = boards.findIndex((b) => b.id === boardId);
        const neighbour = at >= 0 ? boards[at + 1] || boards[at - 1] : null;
        const res = await deleteBoard(boardId);
        if (res?.ok) {
          // Only the board that was on the canvas gets the canvas moved. Taking
          // it somewhere else to tidy a file the user was not looking at throws
          // away the drawing in front of them for nothing.
          if (boardId === activeId) {
            if (neighbour) await sendBoardCommand({ kind: "switch", boardId: neighbour.id });
          }
          track("board:deleted", { boardId, wasActive: boardId === activeId, via: "panel" });
        }
      });
    },
    [boards, activeId, run],
  );

  const reveal = useCallback(
    (boardId) => {
      setMenu(null);
      // The backend opens it, and the host renders the toast.
      //
      // The page used to call `hana.external.open` itself, which reads like the
      // right call — a host capability, taking a URL, exactly this job. It is
      // granted per-ledger with no manifest fallback though, so an app cannot
      // obtain it by declaring it, and the host answers `Plugin UI capability
      // "external.open" has not been granted`. `app/process.spawn` *is* granted
      // by a manifest line, so that path asks once instead of per click.
      //
      // Every step reports rather than assumes. A wrong host capability throws a
      // TypeError before anything is sent, and that looks exactly like doing
      // nothing — which is how two versions of this failed without a log line.
      void (async () => {
        try {
          const res = await revealBoard(boardId);
          await toast(res?.ok ? "已在文件管理器中打开" : "没能打开文件管理器", res?.ok ? "success" : "error");
          track("board:revealed", { boardId, opened: Boolean(res?.ok), detail: res?.detail });
          if (!res?.ok) setError(`${res?.error || "没能打开文件管理器"}${res?.dir ? `\n${res.dir}` : ""}`);
        } catch (err) {
          const message = String(err?.message || err);
          await toast(`打开失败：${message}`, "error");
          setError(`打开失败：${message}`);
        }
      })();
    },
    [],
  );

  /* ---- drag to reorder ------------------------------------------------ */

  const rowEls = useCallback(
    () => Array.from(listRef.current?.querySelectorAll(".bp-row[data-panel-row]") ?? []),
    [],
  );

  /**
   * Where the insertion line goes, in pixels.
   *
   * Slot 0 puts it above the first row and slot `n` below the last, so it needs
   * to reach past the list's own edges — hence the extra 6px of padding when
   * drawing outside, which is what makes "drop at the very top" look like the
   * top rather than like the first row's title.
   */
  const lineTop = useCallback((slot, els, listTop) => {
    if (!els.length) return 0;
    if (slot <= 0) return els[0].getBoundingClientRect().top - listTop - 3;
    if (slot >= els.length) {
      return els[els.length - 1].getBoundingClientRect().bottom - listTop + 3;
    }
    const prev = els[slot - 1].getBoundingClientRect();
    const next = els[slot].getBoundingClientRect();
    return (prev.bottom + next.top) / 2 - listTop;
  }, []);

    const endDrag = useCallback(
    (commit) => {
      const drag = dragRef.current;
      dragRef.current = null;
      if (drag) clearTimeout(drag.hold);
      setDropAt(null);
      setDraggingId(null);
      if (!drag) return;
      if (commit && drag.slot !== null) {
        // The slot counts the dragged row itself, so removing it first is what
        // turns "the line is between rows 3 and 4" into "it becomes row 3".
        const without = boards.filter((b) => b.id !== drag.boardId);
        const to = drag.slot > drag.from ? drag.slot - 1 : drag.slot;
        if (to !== drag.from) {
          void run("排序", async () => {
            await moveBoardTo(drag.boardId, to);
            track("board:moved", { boardId: drag.boardId, from: drag.from, to, via: "drag" });
          });
        }
      }
    },
    [boards, run],
  );

  const onRowPointerDown = useCallback(
    (event) => {
      // Left button only, and never while a menu or the composer is up: a drag
      // started over either of those has somewhere else to go.
      if (event.button !== 0 || menu || composer) return;

      // The row is the event target, so its id comes off its own attribute rather
      // than a closure. `preventDefault` is deliberately NOT called here: it would
      // stop the button taking focus on click, and a mouse drag does not need it —
      // selection is suppressed in CSS, and the real `preventDefault` happens on
      // the first move, once the gesture is known to be a drag.
      const boardId = (event.currentTarget.getAttribute("data-panel-row") || "").replace(/^board:/, "");
      const from = boards.findIndex((b) => b.id === boardId);
      if (!boardId || from < 0) return;

      const touch = event.pointerType === "touch";
      const drag = {
        boardId,
        from,
        slot: null,
        startX: event.clientX,
        startY: event.clientY,
        pointerId: event.pointerId,
        active: false,
        touch,
        hold: 0,
        lastY: event.clientY,
        autoScroll: 0,
        el: event.currentTarget,
      };
      dragRef.current = drag;

      if (touch) {
        // Wait out the hold before becoming a drag. Until it fires, this is a
        // press: move and it is a scroll, release and it is a click.
        drag.hold = setTimeout(() => {
          if (dragRef.current !== drag || drag.active) return;
          drag.active = true;
          suppressClickRef.current = true;
          setDraggingId(drag.boardId);
          setDropAt(0);
        }, TOUCH_HOLD_MS);
      }
    },
    [boards, menu, composer],
  );

  useEffect(() => {
    const onMove = (event) => {
      const drag = dragRef.current;
      if (!drag || event.pointerId !== drag.pointerId) return;
      drag.lastY = event.clientY;
      const moved = Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY);

      if (!drag.active) {
        if (moved >= DRAG_THRESHOLD_PX) {
          // A finger that moved before the hold elapsed is scrolling, not
          // dragging. Drop the pending hold and hand the gesture back to the
          // browser — no `preventDefault`, so the panel scrolls as it always did.
          if (drag.touch) {
            clearTimeout(drag.hold);
            dragRef.current = null;
            return;
          }
        } else {
          return;
        }
        drag.active = true;
        clearTimeout(drag.hold);
        // Take the pointer only now that we know this is a drag. Capturing at
        // `pointerdown` is what retargets the following `click` onto whatever was
        // under the finger and makes the row stop switching boards.
        try {
          drag.el?.setPointerCapture(drag.pointerId);
        } catch {
          /* capture is an optimisation; the window listeners below are the floor */
        }
        // Swallow the click this gesture is about to produce. Decided once, at
        // activation, rather than re-decided at `pointerup` from whatever the
        // pointer happens to be doing then.
        suppressClickRef.current = true;
        setDraggingId(drag.boardId);
        setDropAt(0);
      }
      event.preventDefault();

      const list = listRef.current;
      if (!list) return;
      const panel = list.closest(".bp-panel");
      const els = rowEls();
      const panelRect = panel?.getBoundingClientRect();

      // Auto-scroll: the pointer parked near an edge keeps the list moving, so a
      // long list can be crossed without releasing. Bounded per frame, because
      // an unbounded scroll makes the insertion line unreadable exactly when it
      // matters most.
      if (panelRect) {
        const fromTop = event.clientY - panelRect.top;
        const fromBottom = panelRect.bottom - event.clientY;
        let delta = 0;
        if (fromTop < AUTOSCROLL_EDGE_PX) delta = -AUTOSCROLL_MAX_PX * (1 - fromTop / AUTOSCROLL_EDGE_PX);
        else if (fromBottom < AUTOSCROLL_EDGE_PX)
          delta = AUTOSCROLL_MAX_PX * (1 - fromBottom / AUTOSCROLL_EDGE_PX);
        drag.autoScroll = delta;
        if (delta) list.scrollTop += delta;
      }

      const slot = slotAt(event.clientY, els);
      drag.slot = slot;
      setDropAt(lineTop(slot, els, list.getBoundingClientRect().top));
    };

    const finish = (event) => {
      const drag = dragRef.current;
      if (!drag || (event && event.pointerId !== drag.pointerId)) return;
      // A press that never became a drag was a click, and the row's own onClick
      // has to see it. A touch that was still inside the hold window counts too:
      // a quick tap is a switch, not a cancelled reorder.
      if (!drag.active) {
        dragRef.current = null;
        clearTimeout(drag.hold);
        return;
      }
      try {
        if (drag.el?.hasPointerCapture(drag.pointerId)) drag.el.releasePointerCapture(drag.pointerId);
      } catch {
        /* already released */
      }
      endDrag(true);
    };

    /**
     * Losing the window cancels the drag.
     *
     * Without this, alt-tabbing mid-gesture leaves the drag armed: the listeners
     * are on `window`, so when focus comes back the very next mouse move resumes
     * a drag the user has long since forgotten, and the board moves on its own.
     * `pointercancel` does not fire for a window switch, which is why this needs
     * its own handler.
     */
    const onBlur = () => {
      if (!dragRef.current?.active) return;
      suppressClickRef.current = false;
      endDrag(false);
    };

    const onKey = (event) => {
      if (event.key === "Escape" && dragRef.current) {
        event.preventDefault();
        suppressClickRef.current = false;
        endDrag(false);
      }
    };

    window.addEventListener("pointermove", onMove, { passive: false });
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("blur", onBlur);
    };
  }, [rowEls, lineTop, endDrag]);

  /**
   * Keep the list moving while the pointer is parked past an edge.
   *
   * A separate interval rather than one-shot nudges inside `pointermove`: a
   * pointer held perfectly still produces no moves at all, and without this the
   * list stops exactly when the user is waiting for it to keep going.
   *
   * Keyed on `draggingId`, not on `dropAt`. The line moves on every pointermove,
   * so depending on it would tear down and rebuild this interval sixty times a
   * second — it has to last the whole gesture.
   */
  useEffect(() => {
    if (draggingId === null) return;
    const timer = setInterval(() => {
      const drag = dragRef.current;
      if (!drag?.active || !drag.autoScroll) return;
      const list = listRef.current;
      if (list) list.scrollTop += drag.autoScroll;
    }, 16);
    return () => clearInterval(timer);
  }, [draggingId]);

  /* ---- composer plumbing --------------------------------------------- */

  useEffect(() => {
    if (!composer) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [composer]);

  const onComposerKey = useCallback(
    (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        submitComposer();
      } else if (event.key === "Escape") {
        event.preventDefault();
        setComposer(null);
        setError("");
      }
    },
    [submitComposer],
  );

  /* ---- the menu, per row ---------------------------------------------- */

  /**
   * Ask before deleting, in place.
   *
   * The panel iframe's sandbox has no `allow-modals`, so `window.confirm` and
   * `alert` are unavailable — they do nothing at all rather than showing a
   * dialog. The host's control set has no Modal either. So the confirmation is a
   * second menu in the same place, headed by the sentence that would have been
   * the confirm's body: it asks exactly what a native confirm would have asked,
   * in the only surface this document can put a question in.
   *
   * Declared before `openRowMenu`, which calls it. A closure can legally read a
   * later `const`, but a reader should not have to know that.
   */
  const confirmDelete = useCallback(
    (board) => {
      const at = menuAtRef.current || { x: 24, y: 96 };
      setMenu({
        boardId: board.id,
        at,
        items: [
          {
            id: "ask",
            heading: true,
            label: `删除「${board.title || board.id}」？里面的内容会一起删掉，无法恢复。`,
          },
          { id: "yes", label: "删除", tone: "danger", action: () => removeBoard(board.id) },
          { id: "no", label: "取消", action: () => setMenu(null) },
        ],
      });
    },
    [removeBoard],
  );

  const openRowMenu = useCallback(
    (event, board) => {
      event.preventDefault();
      event.stopPropagation();
      menuAtRef.current = { x: event.clientX, y: event.clientY };
      setMenu({
        boardId: board.id,
        at: menuAtRef.current,
        items: [
          {
            id: "rename",
            label: "重命名",
            action: () => setComposer({ kind: "rename", boardId: board.id, value: board.title || board.id }),
          },
          { id: "reveal", label: "打开文件所在位置", action: () => reveal(board.id) },
          { id: "divider", divider: true },
          { id: "delete", label: "删除", tone: "danger", action: () => confirmDelete(board) },
        ],
      });
    },
    [reveal, confirmDelete],
  );

  useEffect(() => {
    if (!menu) return;
    const onKey = (e) => {
      if (e.key === "Escape") setMenu(null);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [menu]);

  const closeMenu = useCallback(() => {
    menuAtRef.current = null;
    setMenu(null);
  }, []);

  /* ---- render --------------------------------------------------------- */

  const notice = status.notice;
  const exporting = status.exporting;

  const rows = useMemo(
    () =>
      boards.map((b) => {
        const shapes = shapeSummary(b.types);
        return {
          id: b.id,
          title: b.title || b.id,
          // The revision, not a shape breakdown.
          //
          // `rev` is per file: it starts at 1 on create and moves only on a
          // scene write, so renaming or reordering a board does not touch it. In
          // a list that makes it comparable across rows — one board sitting at
          // r191 has churned, the one at r3 has barely been opened. A shape
          // breakdown cannot be compared that way, and in 200px it was always
          // truncated past the second kind anyway.
          subtitle: `r${b.rev}`,
          // The shapes are not thrown away, just moved out of the line: the row's
          // tooltip. Zero pixels, and still one hover away.
          shapes,
          meta: ago(b.updatedAt),
          badge:
            b.id === activeId
              ? { text: "当前", kind: "current" }
              : b.updatedBy === "agent"
                ? { text: "AI", kind: "ai" }
                : null,
          selected: b.id === activeId,
        };
      }),
    [boards, activeId],
  );

  return (
    <div className="bp-panel" data-hana-app-ui>
      {notice && (
        <div className="bp-status" data-panel-section="board-notice">
          <span className="bp-statusLabel">{notice.label}</span>
          <span className="bp-statusValue">{notice.value}</span>
          {notice.delta && (
            <span className="bp-statusDelta" data-tone={notice.tone || "neutral"}>
              {notice.delta}
            </span>
          )}
        </div>
      )}

      {listError && <div className="bp-text" data-tone="danger">读取失败：{listError}</div>}

      <div className="bp-groupTitle" data-panel-section="board-files">
        <span>画板</span>
        <span className="bp-groupTools">
          <span className="bp-groupHint">{boards.length ? `${boards.length} 张` : undefined}</span>
          <button
            type="button"
            className="bp-iconBtn"
            disabled={busy || !!composer}
            onClick={() => setComposer({ kind: "new", value: "" })}
            title="新建画板"
            aria-label="新建画板"
          >
            {/* Outline, 1.8 stroke, 15px — the left rail's icon language. Plain JSX
                SVG children; the host's own control set only carries chevron /
                check / loading / failure, so this one is drawn here. */}
            <svg
              viewBox="0 0 24 24"
              width="15"
              height="15"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              aria-hidden="true"
            >
              <path d="M12 5v14" />
              <path d="M5 12h14" />
            </svg>
          </button>
        </span>
      </div>

      <div
        className="bp-list"
        ref={listRef}
        data-panel-section="board-list"
        data-dragging={dropAt !== null || undefined}
      >
        {rows.length === 0 ? (
          <div className="bp-text">还没有画板</div>
        ) : (
          rows.map((row) => (
            <button
              type="button"
              className="bp-row"
              key={row.id}
              data-panel-row={`board:${row.id}`}
              data-selected={row.selected || undefined}
              data-menu-open={menu?.boardId === row.id || undefined}
              data-dragged={draggingId === row.id || undefined}
              disabled={busy}
              title={`${row.title} · ${row.shapes} · 拖左侧手柄排序，右键可以重命名、找文件、删除`}
              onClick={() => {
                // A drag that just ended produces a click too. Without this the
                // row both reorders and switches, and the user watches the canvas
                // change to a board they were only trying to move.
                if (suppressClickRef.current) {
                  suppressClickRef.current = false;
                  return;
                }
                openBoard(row.id);
              }}
              onPointerDown={onRowPointerDown}
              onContextMenu={(e) => openRowMenu(e, row)}
            >
              <span className="bp-rowBody">
                <span className="bp-rowTitle">{row.title}</span>
                <span className="bp-rowSubtitle">{row.subtitle}</span>
              </span>
              <span className="bp-rowTrailing">
                <span className="bp-rowMeta">{row.meta}</span>
                {row.badge && (
                  <span className="bp-badge" data-kind={row.badge.kind}>
                    {row.badge.text}
                  </span>
                )}
              </span>
            </button>
          ))
        )}
        {dropAt !== null && <div className="bp-dropLine" style={{ top: `${dropAt}px` }} aria-hidden="true" />}
      </div>

      {composer && (
        <div className="bp-composer">
          <label className="bp-composerLabel" htmlFor="bp-composer-input">
            {composer.kind === "rename" ? "新的名字" : "新画板的名字"}
          </label>
          <div className="bp-composerRow">
            <input
              id="bp-composer-input"
              ref={inputRef}
              className="bp-input"
              value={composer.value}
              maxLength={60}
              placeholder={composer.kind === "rename" ? "给这块画板起个名字" : "例如：接口时序草图"}
              onChange={(e) => setComposer((c) => (c ? { ...c, value: e.target.value } : c))}
              onKeyDown={onComposerKey}
            />
            <button type="button" className="bp-action" disabled={busy} onClick={submitComposer}>
              确定
            </button>
            <button
              type="button"
              className="bp-action"
              onClick={() => {
                setComposer(null);
                setError("");
              }}
            >
              取消
            </button>
          </div>
        </div>
      )}

      {error && <div className="bp-error">{error}</div>}

      <div className="bp-actions" data-panel-section="board-file-actions">
        <button
          type="button"
          className="bp-action"
          disabled={!!exporting}
          onClick={() => exportBoard("png")}
        >
          {exporting === "png" ? "导出中…" : "导出 PNG"}
        </button>
        <button
          type="button"
          className="bp-action"
          disabled={!!exporting}
          onClick={() => exportBoard("svg")}
        >
          {exporting === "svg" ? "导出中…" : "导出 SVG"}
        </button>
      </div>

      {menu && <ContextMenu at={menu.at} items={menu.items} onClose={closeMenu} />}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Mount
 * ------------------------------------------------------------------ */

const host = $("sidebar");
if (host) {
  createRoot(host).render(<Sidebar />);
  track("panel:mounted", { route: "sidebar" });
} else if (typeof window !== "undefined") {
  // A page that cannot mount its own root has nothing to report on, so it says
  // so in the one place that is left: the document title.
  window.__boardDiag = { sidebar: "no #sidebar root" };
  document.title = "白板侧栏 · 挂载失败";
}
