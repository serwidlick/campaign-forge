/**
 * Idle detection: calls `onChange(true)` after `timeout` without input, and
 * `onChange(false)` on the next input. Hidden tabs keep counting, so a
 * phone left locked becomes away. Only state changes are reported.
 */

/** Five minutes without touching the device counts as away. */
export const IDLE_AFTER = 5 * 60_000;

const INPUT = ["pointerdown", "pointermove", "keydown", "wheel", "touchstart"];

/** Starts watching; returns a function that stops. */
export function watchIdle({
  onChange,
  timeout = IDLE_AFTER,
  target = globalThis,
} = {}) {
  let idle = false;
  let timer = 0;
  let lastArmed = 0;
  const set = (next) => {
    if (idle === next) return;
    idle = next;
    onChange?.(next);
  };
  const arm = () => {
    clearTimeout(timer);
    lastArmed = Date.now();
    timer = setTimeout(() => set(true), timeout);
  };
  const input = () => {
    set(false);
    // Pointer moves come in floods; re-arming once a second is plenty.
    if (Date.now() - lastArmed >= 1000) arm();
  };
  const visible = () => {
    if (globalThis.document?.visibilityState === "visible") input();
  };
  for (const type of INPUT) {
    target.addEventListener?.(type, input, { capture: true, passive: true });
  }
  globalThis.document?.addEventListener?.("visibilitychange", visible);
  target.addEventListener?.("focus", input);
  arm();
  return () => {
    clearTimeout(timer);
    for (const type of INPUT) {
      target.removeEventListener?.(type, input, { capture: true });
    }
    globalThis.document?.removeEventListener?.("visibilitychange", visible);
    target.removeEventListener?.("focus", input);
  };
}
