/**
 * App-storage keys that the app process and the page have to agree on.
 *
 * They live here rather than in either side's own file because they cross the
 * boundary: one side writes, the other reads. A key spelled in two places is a
 * key that eventually gets spelled two ways, and a key that does not match is
 * not an error — it is a listener that never fires, which is the exact shape
 * every bug in this family has taken (开发记录 R21, R57).
 *
 * Keys live under `ui:` on purpose. The `board:` family used to be scene
 * records in storage and is now only a migration source, and one panel bug ago a
 * key named `board:active` was picked up by every listener matching `board:`,
 * which made "switch board" look like a scene change and ran the revision
 * counter from 107 to 127 in a few minutes. The prefix families must not meet.
 */

/** Which board the canvas is showing. Written by whoever last chose one. */
export const ACTIVE_BOARD_KEY = "ui:activeBoard";

/**
 * Which board was most recently shared into the conversation.
 *
 * Written by `board_share`, read by the preview card. It is separate from the
 * active board because the two answer different questions — "what did the agent
 * just show you" versus "what are you looking at" — and the page resolves them
 * by taking whichever is newer.
 */
export const SHARED_BOARD_KEY = "ui:sharedBoard";
