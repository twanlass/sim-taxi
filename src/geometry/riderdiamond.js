import * as THREE from 'three';
import { URGENCY_SEGMENTS, urgencyColor } from '../game/urgency.js';
import {
  createDiamond, DIAMOND_R, RIM_SCALE, bounceOffset, kickEnvelope, KICK_TIME, KICK_SCALE, KICK_HOP,
} from './diamond.js';

// The marker floating over a waiting rider: a geodesic diamond painted by how close this rider is
// to giving up — green, yellow, orange, red.
//
// It replaces a meter: a dark plate carrying a four-segment urgency bar over a three-segment
// distance bar. The plate said two things, and only one of them was worth the screen. Urgency is
// the question the player is actually asking on the kerb, and a hue answers it in a glance, where
// counting lit blocks is a read. The distance bar went with the plate — see
// gameplay.md#neither-how-far-nor-where — and with it the second thing the player had to parse
// before choosing between two riders.
//
// Geometry rather than a canvas texture, like everything else here — and because the module has to
// construct under `node` for the headless tools, which have no DOM to draw into.

// Clear of the rider's head. The figure tops out a little over 3.3, so a diamond centred at 6.6
// leaves its bottom vertex 1.3 units — about 10px at play zoom — of air above them: enough that it
// reads as floating over the rider rather than worn as a hat. That is the same gap the meter's
// plate was tuned to, so nothing about the rider's slot in the skyline moves.
const LIFT = DIAMOND_R + 4.7;

// The outline once the taxi has been sent at this rider: the same black, drawn heavier. 1.34 is
// about 5px of rim at play zoom against the ordinary 1.7px — the diamond reads as inked.
//
// Weight rather than colour. The rim was the taxi's yellow first, which is the colour that means
// "you told me to do this" everywhere else in the HUD; but this crystal spends a quarter of every
// clock *being* yellow, and a yellow rim on a yellow diamond is no rim at all. Black is the one
// value nothing on the urgency scale can collide with.
const SELECTED_RIM = 1.34;

/**
 * One rider's diamond. Built once per fare slot and re-set on every spawn, the same way the rest of
 * the slot's meshes are reused.
 *
 * `phase` offsets the bounce so two riders waiting at once don't pulse in lockstep. It is a
 * constant per slot rather than anything random, because the bounce is driven off sim time and
 * screenshots have to be reproducible.
 */
export function createRiderDiamond(phase = 0) {
  const group = new THREE.Group();
  group.position.y = LIFT;
  group.visible = false;

  const diamond = createDiamond(urgencyColor(URGENCY_SEGMENTS));
  // The rider under it is the click target — the marker's oversized hit box already covers this
  // whole airspace, so intersecting the crystal itself would only cost work on every tap.
  diamond.mesh.raycast = () => {};
  diamond.rim.raycast = () => {};
  group.add(diamond.mesh);

  let selected = false;
  let level = URGENCY_SEGMENTS;
  // Sim time the running kick started at, or null when none is. Stamped inside update() off the
  // same clock the bounce reads — a frozen shot has to render the same frame every time, and
  // stamping it in setUrgency would tie the animation to the order the two are called in.
  let kickAt = null;
  let kickPending = false;

  /**
   * Paint the diamond in this level's colour, kicking it if the level actually moved.
   *
   * Called every frame while the rider waits, so the common path is a compare and a return. The
   * kick is what makes a level change an *event*: the hue snaps between four steps and the player
   * is usually looking at the road, so without motion the change happens off the corner of the eye
   * and the news arrives late.
   */
  function setUrgency(next) {
    if (next === level) return;
    level = next;
    diamond.setColor(urgencyColor(next));
    kickPending = true;
  }

  function setSelected(on) {
    if (on === selected) return;
    selected = on;
    diamond.setRim(on ? SELECTED_RIM : RIM_SCALE);
  }

  return {
    group,
    // The crystal itself, so a test can read the colour back off the material the way a player
    // reads it off the screen rather than trusting the argument it passed in.
    mesh: diamond.mesh,
    setUrgency,
    /** Mark the rider the taxi has been sent at. */
    setSelected,
    isSelected: () => selected,
    /** Whether the level-change kick is mid-flight — for the headless tools. */
    isKicking: () => kickPending || kickAt !== null,
    /** Show the diamond for a fare that has just appeared — nobody has been sent at it yet. */
    show(nextLevel) {
      // Straight to the opening colour with no kick: a marker that pops the moment it appears is
      // announcing a change that hasn't happened.
      level = nextLevel;
      diamond.setColor(urgencyColor(nextLevel));
      kickAt = null;
      kickPending = false;
      diamond.mesh.scale.setScalar(1);
      setSelected(false);
      group.visible = true;
    },
    hide() { group.visible = false; },
    /**
     * Bounce, plus whatever is left of the last level change's kick.
     *
     * Driven off sim time rather than an accumulated dt so a frozen shot always renders the same
     * frame. Freezes while hidden for the same reason.
     */
    update(elapsed) {
      if (!group.visible) return;
      if (kickPending) {
        kickAt = elapsed;
        kickPending = false;
      }
      let kick = 0;
      if (kickAt !== null) {
        const since = elapsed - kickAt;
        // Retired on the clock, not on the value: the envelope is 0 at both ends, so clearing when
        // it reads 0 killed every kick on its own first frame.
        if (since >= KICK_TIME) kickAt = null;
        else kick = kickEnvelope(since);
      }
      diamond.mesh.position.y = bounceOffset(elapsed + phase) + kick * KICK_HOP;
      diamond.mesh.scale.setScalar(1 + kick * KICK_SCALE);
    },
  };
}
