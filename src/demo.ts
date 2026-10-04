import type { Editor } from "tldraw";
import { applyToPage } from "./project/canvas";
import { demoProject } from "./project/demo";
import { engine } from "./sim/runtime";

/** Replaces the current page's system with the coffee-shop example. */
export function loadDemo(editor: Editor) {
  applyToPage(editor, editor.getCurrentPageId(), demoProject());
  engine.reset();
  editor.zoomToFit({ animation: { duration: 300 } });
}
