/**
 * A cut to black and back — the whole of what skipping a cut scene looks like.
 *
 * The screen goes black, the thing being skipped is *landed* underneath it while nobody can see
 * anything happen, and the black lifts on the game already running. That middle beat is the entire
 * point: the opening vignette ends with the camera fifteen units off a garage door and the taxi
 * halfway down a driveway, and a skip that simply stopped it would either snap the framing across
 * a third of the map or spend two seconds easing there — which is the wait the player just asked
 * to be let out of. Hidden behind the black, the same handover costs one invisible frame.
 *
 * Milliseconds rather than sim seconds, and wall-clock timers rather than the frame loop: this is
 * a transition on the *glass*, not an event in the city, and it has to keep its timing whatever
 * the sim is doing behind it — including a frame loop that is about to be handed a large `dt`.
 */

// Out fast, in slower. Going to black is the answer to the tap and wants to feel like the press
// landed; coming back is the game arriving, and a reveal that snaps reads as a dropped frame
// rather than as a cut. The hold in between is what makes it a cut at all — without a beat of
// actual black the two fades read as one dip and the skip looks like a stutter.
const OUT_MS = 160;
const HOLD_MS = 90;
const IN_MS = 300;

const stillPlease = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

/**
 * @param root  the full-screen black div (`#wipe`), or null on a page that has none — in which
 *              case this returns null and the caller does its work without the cover.
 */
export function createWipe(root) {
  if (!root) return null;

  // True from the tap until the black *starts* lifting, which is the span anything queued behind
  // the skip should stay held for: a tutorial bubble that began typing under the black would have
  // spent half its line by the time the player could read it.
  let covering = false;
  let anim = null;

  /**
   * Fade to black, run `atBlack` on a screen nobody can see, and fade back in.
   *
   * Returns false if a wipe is already running — a second tap during the fade is swallowed rather
   * than restarting it, so a double tap cannot land the skip twice.
   */
  function cut(atBlack) {
    if (covering) return false;
    covering = true;
    anim?.cancel();
    root.hidden = false;
    // Takes the taps for as long as it is opaque, so a finger that lands on the black does not
    // dispatch the taxi at whatever the fade-in is about to reveal underneath it.
    root.style.pointerEvents = 'auto';

    const reveal = () => {
      atBlack();
      covering = false;
      // The screen is the player's again the moment it starts coming back — the run is live under
      // there and a tap on a rider they can see should count.
      root.style.pointerEvents = 'none';
      anim?.cancel();
      anim = root.animate([{ opacity: 1 }, { opacity: 0 }],
        { duration: IN_MS, easing: 'ease-out' });
      // No `fill`: the keyframes land on the element's own `opacity: 0`, so there is nothing to
      // hold and nothing to snap back from if this is cancelled.
      anim.onfinish = () => { root.hidden = true; };
    };

    // Reduced motion gets the cut without the fades, the same trade the pause veil makes: the
    // request is for less animation, and a hard cut is what less animation than a cut looks like.
    if (stillPlease()) {
      atBlack();
      covering = false;
      root.style.pointerEvents = 'none';
      root.hidden = true;
      return true;
    }

    // `fill: 'forwards'` is what holds the black through `HOLD_MS` — without it the element drops
    // back to its own `opacity: 0` the instant the fade ends and the city flashes back for the
    // exact frames the skip is supposed to happen behind.
    anim = root.animate([{ opacity: 0 }, { opacity: 1 }],
      { duration: OUT_MS, easing: 'ease-in', fill: 'forwards' });
    anim.onfinish = () => setTimeout(reveal, HOLD_MS);
    return true;
  }

  return { cut, covering: () => covering };
}
