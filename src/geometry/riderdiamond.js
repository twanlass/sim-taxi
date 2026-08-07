import * as THREE from 'three';
import { PALETTE } from '../palette.js';
import { URGENCY_SEGMENTS, urgencyColor } from '../game/urgency.js';
import { createDiamond, DIAMOND_R, RIM_SCALE, bounceOffset } from './diamond.js';

// The marker floating over a waiting rider: the same geodesic diamond the drop-off wears, painted
// by how close this rider is to giving up — green, yellow, orange, red.
//
// It replaces a meter: a dark plate carrying a four-segment urgency bar over a three-segment
// distance bar. The plate said two things, and only one of them was worth the screen. Urgency is
// the question the player is actually asking on the kerb, and a hue answers it in a glance, where
// counting lit blocks is a read. The distance bar went with the plate — see
// gameplay.md#neither-how-far-nor-where — and with it the second thing the player had to parse
// before choosing between two riders.
//
// Reusing the drop-off's model is deliberate: both ends of a fare are now the same crystal, and
// the colour is the only difference between "someone is waiting here" and "take them there". One
// silhouette to learn instead of two.
//
// Geometry rather than a canvas texture, like everything else here — and because the module has to
// construct under `node` for the headless tools, which have no DOM to draw into.

// Clear of the rider's head. The figure tops out a little over 3.3, so a diamond centred at 6.6
// leaves its bottom vertex 1.3 units — about 10px at play zoom — of air above them: enough that it
// reads as floating over the rider rather than worn as a hat. That is the same gap the meter's
// plate was tuned to, so nothing about the rider's slot in the skyline moves.
//
// Lower than the drop-off pin's 9.6 on purpose. That one floats over an empty kerb corner and has
// only itself to belong to; this one has to look attached to the person under it.
const LIFT = DIAMOND_R + 4.7;

// The rim when the taxi has been sent at this rider — the Loco Mode pill's yellow, which is the
// taxi's own, on the same edge that is otherwise black. It thickens as well as changing colour:
// at play zoom the ordinary 1.12 rim is ~1.7px, and a hue swap that fine reads as an artefact of
// the light rather than as a state. 1.24 is ~3.5px, past the 2.5px the plate's ring needed to read
// as a deliberate edge.
const SELECTED_RIM = 1.24;
const RIM_BLACK = 0x000000;

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

  /** Paint the diamond in this level's colour. Called every frame while the rider waits. */
  function setUrgency(level) {
    diamond.setColor(urgencyColor(level));
  }

  function setSelected(on) {
    if (on === selected) return;
    selected = on;
    diamond.setRim(on ? PALETTE.riderSelected : RIM_BLACK, on ? SELECTED_RIM : RIM_SCALE);
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
    /** Show the diamond for a fare that has just appeared — nobody has been sent at it yet. */
    show(level) {
      setUrgency(level);
      setSelected(false);
      group.visible = true;
    },
    hide() { group.visible = false; },
    /**
     * Bounce, driven off sim time rather than an accumulated dt so a frozen shot always renders the
     * same frame. Freezes while hidden for the same reason.
     */
    update(elapsed) {
      if (!group.visible) return;
      diamond.mesh.position.y = bounceOffset(elapsed + phase);
    },
  };
}
