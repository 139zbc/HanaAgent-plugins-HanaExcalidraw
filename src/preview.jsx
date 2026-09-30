import { createRoot } from "react-dom/client";
import ExcalidrawBoard from "./ExcalidrawBoard.jsx";
import { readActiveBoard } from "./boardClient.js";

/**
 * The in-chat preview entry.
 *
 * Mounted by the `board-preview` card, which `contributes.messageRenderers` maps
 * the `board-preview` custom type onto. That is what `board_share` posts, so the
 * message a user sees beside a diagram is this page.
 *
 * Two constraints shape it:
 *
 *   - **The host passes nothing to this iframe.** A messageRenderer card gets no
 *     payload and no query string, so the board to show cannot come from the
 *     message. It comes from `ui:activeBoard` instead — the same key the main card
 *     uses, which is the board the agent just drew on, so the preview shows what
 *     was shared.
 *   - **It must be read-only.** Rendering the normal card would offer a toolbar,
 *     a dock and a function panel inside a chat stream, and edits made there
 *     would have nowhere sensible to go. `readOnly` turns all of that off.
 *
 * The board id is resolved *before* mounting, because `ExcalidrawBoard` reads it
 * once during its first render (PLAN.md R13) and a late-arriving id would paint
 * the wrong board first.
 */
async function main() {
  const root = document.getElementById("root");
  if (!root) return;
  if (window.__boardDiag) window.__boardDiag.module = true;

  let boardId = "main";
  try {
    // `readActiveBoard` returns null when nothing has been shared yet; falling
    // back to `main` keeps the card from rendering an error instead of a board.
    boardId = (await readActiveBoard()) || "main";
  } catch (err) {
    console.warn("[excalidraw] preview could not read the active board:", err?.message || err);
  }

  createRoot(root).render(<ExcalidrawBoard boardId={boardId} readOnly />);
}

main();
