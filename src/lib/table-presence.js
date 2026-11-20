/**
 * Who is at the table: the public face of the presence bubbles. The parts
 * live in ./presence/ (one job each); pages import from here.
 *
 *   import { mountTablePresence } from "./table-presence.js";
 *   const el = mountTablePresence({ stylesheet: "/table-presence.css" });
 *   el.roster = entries;            // from the table's live frames
 *   el.clockOffset = offset;        // when the roster came from another machine
 *   el.you = key;                   // this device's person: marked "you"
 *   el.offline = true;              // while the host cannot be reached
 *   el.setActivity(key, "messaging");   // see presence/activities.js
 *   new TableChat({ send }).attach(el); // table messages (presence/chat.js)
 *
 * Statuses and activities are registries: add one with `defineStatus` or
 * `defineActivity` and the bubbles pick it up. `watchIdle` reports when the
 * person at this device has gone quiet, for the page to tell the table.
 *
 * The host serves these same files to phones (src-tauri/src/table/server.rs),
 * so everything here is plain browser JavaScript with no build step.
 */

export {
  TAG,
  TablePresence,
  defineTablePresence,
  mountTablePresence,
} from "./presence/element.js";
export { defineStatus, statusOf } from "./presence/statuses.js";
export { defineActivity, activityOf } from "./presence/activities.js";
export { defineIcon } from "./presence/icons.js";
export { IDLE_AFTER, watchIdle } from "./presence/idle.js";
export { formatDuration } from "./presence/time.js";
export { TableChat } from "./presence/chat.js";
export {
  defineCardSection,
  defineCardAction,
} from "./presence/card-sections.js";
export {
  defineHaptic,
  haptic,
  setHapticDriver,
  setHapticsEnabled,
} from "./presence/haptics.js";

// In development, a change to any of these files reloads the page instead
// of patching it in place: <table-presence> is registered once per page, so
// a hot update would leave the old element running. (Phones and builds have
// no dev server; there this does nothing.)
if (import.meta.hot) import.meta.hot.decline();
