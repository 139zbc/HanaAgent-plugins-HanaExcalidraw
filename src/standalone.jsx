import { createRoot } from "react-dom/client";
import ExcalidrawBoard from "./ExcalidrawBoard.jsx";

if (window.__boardDiag) window.__boardDiag.module = true;

createRoot(document.getElementById("root")).render(<ExcalidrawBoard />);
