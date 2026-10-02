import { createRoot } from "react-dom/client";
import ExcalidrawBoard from "./ExcalidrawBoard.jsx";
import { readPreviewBoard } from "./boardClient.js";

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
 *     payload and no query string, and the card's `route` has to keep matching
 *     the manifest's declared `route` exactly, so neither of the two places a
 *     message could normally travel is available. The board id comes from App
 *     storage instead: `ui:sharedBoard` (written by `board_share`) and
 *     `ui:activeBoard` (written when the user picks a board), newest first.
 *     Reading only the second one showed the board the *user* was on, which is
 *     the right answer only when the agent drew on that same board — a card
 *     titled with one board and painting another, silently.
 *   - **It must be read-only.** Rendering the normal card would offer a toolbar,
 *     a dock and a function panel inside a chat stream, and edits made there
 *     would have nowhere sensible to go. `readOnly` turns all of that off.
 *
 * The board id is resolved *before* mounting, because `ExcalidrawBoard` reads it
 * once during its first render (开发记录 R13) and a late-arriving id would paint
 * the wrong board first.
 */
async function main() {
  const root = document.getElementById("root");
  if (!root) return;
  if (window.__boardDiag) window.__boardDiag.module = true;

  let boardId = "main";
  try {
    // Falls back to `main` when nothing has been shared or opened yet, so the
    // card renders a board rather than an error.
    boardId = (await readPreviewBoard()) || "main";
  } catch (err) {
    console.warn("[excalidraw] preview could not resolve its board:", err?.message || err);
  }

  createRoot(root).render(<ExcalidrawBoard boardId={boardId} readOnly />);
}

main();
