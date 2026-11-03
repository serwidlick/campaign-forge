import { DocumentPanel } from "@/features/documents/DocumentPanel";
import { MapPanel } from "@/features/map/MapPanel";
import { ArcPanel } from "@/features/sessions/ArcPanel";
import { SessionPanel } from "@/features/sessions/SessionPanel";
import { JournalPanel } from "@/features/journal/JournalPanel";
import { EventPanel } from "@/features/timeline/EventPanel";
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
    case "journal":
      return (
        <ElementEditor
          element={element}
          panel={<JournalPanel element={element} />}
        />
      );
    case "event":
      return (
        <ElementEditor
          element={element}
          panel={<EventPanel element={element} />}
        />
      );
    case "document":
      return (
        <ElementEditor
          element={element}
          panel={<DocumentPanel element={element} />}
        />
      );
    case "map":
      return (
        <ElementEditor
          element={element}
          panel={<MapPanel element={element} />}
        />
      );
    default:
      return <ElementEditor element={element} />;
  }
}
