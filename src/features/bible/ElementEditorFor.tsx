import { ArcPanel } from "@/features/sessions/ArcPanel";
import { SessionPanel } from "@/features/sessions/SessionPanel";
import type { Element } from "@/lib/types";

import { ElementEditor } from "./ElementEditor";

/**
 * Picks the kind-specific panel for an element. Every kind shares the same
 * header, Markdown body and backlinks; sessions and arcs add structure above.
 */
export function ElementEditorFor({ element }: { element: Element }) {
  switch (element.type) {
    case "session":
      return (
        <ElementEditor
          element={element}
          panel={<SessionPanel element={element} />}
        />
      );
    case "arc":
      return (
        <ElementEditor
          element={element}
          panel={<ArcPanel element={element} />}
        />
      );
    default:
      return <ElementEditor element={element} />;
  }
}
