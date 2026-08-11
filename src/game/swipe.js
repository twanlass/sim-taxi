/**
 * The swipe gesture, as an input.
 *
 * Structurally this is the `attachDragPan` it replaced with the panning taken out — which is the
 * point, because that code had already paid for the three things a pointer gesture on this canvas
 * gets wrong. All three carry over verbatim:
 *
 *   - **Primary pointer only.** A second touch belongs to a pinch; feeding it into the same gesture
 *     reads a jump from wherever that finger landed as a swipe.
 *   - **Pointer capture**, so a finger that leaves the canvas mid-gesture still completes it.
 *   - **`didSwipe()` survives exactly one synthesised click, then clears itself on a queued task.**
 *     `pointerup` and `click` dispatch in the same task, so the one click this is protecting still
 *     sees the flag; anything later is a new tap. Clearing it on the *next* pointerdown instead —
 *     which is what the pan version did first — left a gesture from minutes ago still reading as in
 *     progress, and every tap on the tutorial bubble or a rider-finder chip got eaten as its tail.
 *
 * What is different is when it fires. A pan reports itself every move event because it is a
 * continuous drag; a swipe is one instruction, so it fires **once**, on the frame the travel from
 * `pointerdown` crosses `SWIPE_MIN`, and then latches until the finger lifts. Waiting for
 * `pointerup` was the obvious alternative and it is wrong here: the window to steer a junction is
 * 8.6 units of road — **1.0s at cruise, 0.37s at the overdrive top** — and a control that will not
 * answer until you let go spends a good slice of it doing nothing.
 */

// How far a finger has to travel before it means anything, in CSS pixels. Above the 8px of slop a
// tap smears by on a phone, and low enough that a flick along one block of road clears it easily —
// a block is ~92px across at play zoom.
export const SWIPE_MIN = 28;

/**
 * @param domElement  the canvas
 * @param onSwipe     (dx, dy, originX, originY) => void, in CSS pixels with DOM axes. The origin is
 *                    where the finger went down, which is where the on-screen feedback belongs.
 * @param isEnabled   live check, so a resize or the run ending can switch steering off without a
 *                    listener being rebound.
 * @param minDistance live too, and for the same reason: it is a feel constant, and feel constants
 *                    are tuned in the browser against a moving city rather than in a file.
 */
export function createSwipe(domElement, onSwipe, isEnabled = () => true,
  minDistance = () => SWIPE_MIN) {
  let gesture = null;
  let swiped = false;
  let clearSwiped = null;

  domElement.addEventListener('pointerdown', (event) => {
    if (!event.isPrimary || !isEnabled()) return;
    clearTimeout(clearSwiped);
    gesture = { x: event.clientX, y: event.clientY, fired: false };
    swiped = false;
    domElement.setPointerCapture(event.pointerId);
  });

  const release = () => {
    gesture = null;
    if (swiped) clearSwiped = setTimeout(() => { swiped = false; }, 0);
  };
  domElement.addEventListener('pointerup', release);
  domElement.addEventListener('pointercancel', release);

  domElement.addEventListener('pointermove', (event) => {
    if (!gesture || gesture.fired || !event.isPrimary) return;
    const dx = event.clientX - gesture.x;
    const dy = event.clientY - gesture.y;
    // Straight-line displacement from where the finger went down, not distance travelled. A curled
    // flick covers plenty of path while ending up nowhere, and its *direction* is the only thing
    // this control cares about — reading it off an arc that doubled back would send the taxi the
    // way the finger came from.
    if (Math.hypot(dx, dy) < minDistance()) return;

    gesture.fired = true;
    swiped = true;
    onSwipe(dx, dy, gesture.x, gesture.y);
  });

  return {
    /** True if the gesture that just ended was a swipe — the picker's and the tutorial's guard. */
    didSwipe: () => swiped,
  };
}
