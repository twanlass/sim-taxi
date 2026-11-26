import * as THREE from 'three';
import { CRYSTAL_TOP } from './faremarker.js';
import { INLINE_ICONS } from './speech.js';

// The robo-taxi lock-on, said at the rider — Arcade's rider race (fares.js RACE_WAITING).
//
// A rider a robo-taxi has claimed gets the cyan robot over their crystal: the same picture the
// dispatch line uses (`{:robotaxi}`), so it means one thing everywhere. It is one half of the lock
// cue; the other half is on the road, the robot's own route to the rider laid in its cyan (main.js
// `claimLines`) with the ring under the rider snapping in to them (game/robotaxi.js). Tyler,
// 2026-11-26: the robots already took riders, "it's not obvious though which riders they are
// targeting". The pick is made in a split second, so the cue has to be one shape you can see from
// across the map, not something to read: a rider with a robot over them is spoken for.
//
// A DOM image rather than a mesh, for the pops' reason: the same size whatever the zoom, and crisp.
// It pops in on the frame of the claim (`.is-new`), so a claim landing is an event rather than a
// change of state you might miss. Placed over the crystal's highest point (CRYSTAL_TOP) rather than
// tracking its bounce. Dimmed while the seat is full, with the rest of the waiting rider's mark
// (the board's step-back), and gone while the rider's slot is hidden (a getaway) or off screen.

const LIFT = CRYSTAL_TOP + 0.5;

export function createRiderTags({ camera, viewport, host = document.getElementById('rider-tags') }) {
  const tags = [];
  const v = new THREE.Vector3();

  function tagAt(k) {
    if (tags[k]) return tags[k];
    const el = document.createElement('img');
    el.className = 'rider-tag';
    el.alt = '';
    el.src = INLINE_ICONS.robotaxi;
    el.hidden = true;
    host?.append(el);
    tags[k] = { el, fare: null, dim: null };
    return tags[k];
  }

  /**
   * @param fares    the waiting fares, or [] to take every tag down
   * @param kerbOf   (fare) => { x, z } — where the rider stands (fares.js `kerbFor`)
   * @param claimed  (fare) => truthy when a robo-taxi is hunting them
   * @param dim      true while the seat is full
   */
  function update(fares, kerbOf, claimed, dim) {
    const w = viewport.width();
    const h = viewport.height();
    let k = 0;
    for (const fare of fares) {
      if (fare.stage !== 'waiting' || !claimed(fare)) continue;
      if (fare.slot?.root && !fare.slot.root.visible) continue;
      const at = kerbOf(fare);
      v.set(at.x, LIFT, at.z).project(camera);
      if (v.z > 1 || Math.abs(v.x) > 1.1 || Math.abs(v.y) > 1.1) continue;
      const tag = tagAt(k++);
      tag.el.hidden = false;
      tag.el.style.left = `${((v.x * 0.5 + 0.5) * w).toFixed(1)}px`;
      tag.el.style.top = `${((-v.y * 0.5 + 0.5) * h).toFixed(1)}px`;
      if (tag.fare !== fare) {
        // A new claim on this pooled tag: replay the pop.
        tag.fare = fare;
        tag.el.classList.remove('is-new');
        void tag.el.offsetWidth;
        tag.el.classList.add('is-new');
      }
      if (dim !== tag.dim) { tag.dim = dim; tag.el.classList.toggle('is-dim', dim); }
    }
    for (; k < tags.length; k++) { tags[k].el.hidden = true; tags[k].fare = null; }
  }

  return { update, hide: () => update([], null, () => false, false) };
}
