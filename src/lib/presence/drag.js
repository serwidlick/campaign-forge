/**
 * Press-and-drag on a group of handles, with taps left as taps.
 *
 * Any element matching `handle` inside `root` starts a press. Once it has
 * travelled `threshold` pixels it is a drag: `onStart()`, then `onMove(dx,
 * dy)` with the offset from where it started, then `onEnd()` once released
 * or interrupted. The click a browser fires after a drag is swallowed
 * before anything else hears it. The pointer is captured on the pressed
 * handle, so moves still bubble to `root` and a plain tap still clicks it.
 */
export class DragController {
  #root;
  #handle;
  #threshold;
  #on;
  #press = null;
  #swallow = false;

  constructor(root, { handle, threshold = 5, onStart, onMove, onEnd }) {
    this.#root = root;
    this.#handle = handle;
    this.#threshold = threshold;
    this.#on = { onStart, onMove, onEnd };
    root.addEventListener("pointerdown", this.#down);
    root.addEventListener("pointermove", this.#move);
    root.addEventListener("pointerup", this.#up);
    root.addEventListener("pointercancel", this.#up);
    // Capture lost any other way (the element moved, the browser took the
    // gesture) ends the press too, so no drag is left half done.
    root.addEventListener("lostpointercapture", () => this.end());
    root.addEventListener("click", this.#click, true);
  }

  /** Whether a drag (not just a press) is under way. */
  get dragging() {
    return this.#press?.dragging === true;
  }

  /** Ends any press; a drag in progress finishes as if released. Safe to
   *  call at any time, and called when the host element leaves the page. */
  end() {
    const press = this.#press;
    this.#press = null;
    if (!press) return;
    try {
      if (press.handle.hasPointerCapture(press.id)) {
        press.handle.releasePointerCapture(press.id);
      }
    } catch {
      /* the pointer is already gone */
    }
    if (press.dragging) this.#on.onEnd?.();
  }

  /** Forgets a pending click to swallow (the page is going away). */
  reset() {
    this.end();
    this.#swallow = false;
  }

  #down = (event) => {
    if (event.button !== 0 || !event.isPrimary) return;
    const handle = event.target.closest?.(this.#handle);
    if (!handle) return;
    this.#swallow = false;
    this.#press = {
      id: event.pointerId,
      handle,
      startX: event.clientX,
      startY: event.clientY,
      dragging: false,
    };
    try {
      handle.setPointerCapture(event.pointerId);
    } catch {
      /* the pointer is no longer active; the press simply never drags */
    }
  };

  #move = (event) => {
    const press = this.#press;
    if (!press || event.pointerId !== press.id) return;
    const dx = event.clientX - press.startX;
    const dy = event.clientY - press.startY;
    if (!press.dragging) {
      if (Math.hypot(dx, dy) < this.#threshold) return;
      press.dragging = true;
      this.#on.onStart?.();
    }
    this.#on.onMove?.(dx, dy);
  };

  #up = (event) => {
    const press = this.#press;
    if (!press || event.pointerId !== press.id) return;
    const dragged = press.dragging;
    this.end();
    // The click that follows a drag is not a tap. (Set after `end`, whose
    // release of capture comes between this pointerup and that click.)
    this.#swallow = dragged && event.type === "pointerup";
  };

  #click = (event) => {
    if (!this.#swallow) return;
    this.#swallow = false;
    event.stopPropagation();
    event.preventDefault();
  };
}
