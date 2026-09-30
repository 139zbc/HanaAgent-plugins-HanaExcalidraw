import { createRoot } from "react-dom/client";
import ExcalidrawBoard from "./ExcalidrawBoard.jsx";

// Report back to the inline boot diagnostics: reaching this line means the
// module graph loaded and evaluated.
if (window.__boardDiag) window.__boardDiag.module = true;

createRoot(document.getElementById("root")).render(<ExcalidrawBoard />);
