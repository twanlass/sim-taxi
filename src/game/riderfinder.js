import * as THREE from 'three';
import { createPerson } from '../geometry/person.js';
import { mirrorSceneLights } from './avatarlights.js';
import { urgencyColorFor } from './urgency.js';
import { PALETTE } from '../palette.js';
import { getMsaa, getPixelRatioCap } from '../util/shot.js';

// A HUD row above the Loco Mode pill, left-aligned to it, so both controls sit under the same
// thumb.
//
// A waiting rider is a handful of pixels among a hundred buildings, and on a phone the whole city
// doesn't fit in one screen. Each waiting fare gets its own chip here — same animated figure the
// player is hunting for, with the fare's own countdown ring around it — and one tap selects that
// rider, dispatching the taxi at them, so the whole loop works without ever having to find the pin
// on the map. It was a double-tap once, with the first tap only moving the camera; picking a rider
// is the one thing the chip is for, and making it cost two taps on a clock that is draining was
// worse than the camera move was worth. Two clocks on the kerb means two chips on screen; the row
// grows rightward so the first slot stays put next to the Loco Mode pill and extra riders pile
// on beside it.
//
// One WebGL renderer per chip. MAX_FARES caps the pool at three, so the extra contexts are well
// under any browser limit. Cheaper alternatives (one renderer, blit to N canvases) exist but the
// figure and the waiting person are the same little scene, so keeping the mini-renderer symmetric
// with the main one keeps this module short.
//
// The chip disc is a plain dark bubble the three.js canvas draws the figure onto; the countdown
// ring around it is a CSS conic-gradient driven from game/urgency.js — the same scale the fare's
// own diamond is painted from out on the map, so the two read as one clock.

const SIZE = 38;      // matches the visible chip disc inside the button

function createChip(onSelect, sun, hemi) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'rider-finder-chip';
  button.setAttribute('aria-label', 'Send the taxi to this waiting rider');

  const chip = document.createElement('span');
  chip.className = 'chip';
  const canvas = document.createElement('canvas');
  canvas.width = SIZE;
  canvas.height = SIZE;
  chip.appendChild(canvas);
  button.appendChild(chip);

  // One more WebGL context per chip, and each honours the same budget flags the main renderer
  // does — see `util/shot.js`. Not for its own cost, which is a 38px disc, but because `?safe` is
  // asking a device "what will you render at all" and every context this page opens is part of
  // that answer.
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: getMsaa(), alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, getPixelRatioCap()));
  renderer.setSize(SIZE, SIZE, false);
  renderer.setClearColor(0x000000, 0);

  const scene = new THREE.Scene();

  // The city's own sun and hemisphere fill, mirrored in (see game/avatarlights.js — shared with
  // the tutorial bubble's avatar) rather than a flat studio rig: the figure standing in this chip
  // is the same one waiting on the kerb outside it, so it should be lit by the same afternoon.
  const syncLights = mirrorSceneLights(scene, sun, hemi);

  const person = createPerson();
  scene.add(person.group);

  // Ortho frustum sized to fit the ~3.2-unit-tall figure with a little air. Looking slightly down
  // and from the front so the wave arm is clearly visible. `createPerson`'s torso is thin on Z and
  // wide on X (shoulders either side, chest facing along Z — see `board()`'s "local +Z is treated
  // as forward"), so the camera sits on +Z, not +X, to look at the figure head-on.
  const camera = new THREE.OrthographicCamera(-2.2, 2.2, 2.7, -1.5, 0.1, 40);
  camera.position.set(0, 3.2, 4.9);
  camera.lookAt(0, 1.55, 0);

  let currentFare = null;
  button.addEventListener('click', () => {
    if (currentFare && onSelect) onSelect(currentFare);
  });

  return {
    button,
    render: () => { syncLights(); renderer.render(scene, camera); },
    wave: (t) => person.wave(t),
    setFare(fare) { currentFare = fare; },
  };
}

export function createRiderFinder({ onSelect, sun, hemi }) {
  const stack = document.getElementById('rider-finder-stack');
  if (!stack) return { update: () => {} };

  const chips = [];
  let elapsed = 0;

  function chipAt(i) {
    if (chips[i]) return chips[i];
    const chip = createChip(onSelect, sun, hemi);
    stack.appendChild(chip.button);
    chips[i] = chip;
    return chip;
  }

  function update(dt, waitingFares) {
    elapsed += dt;

    // Sort by slot index so a chip stays put on screen while its fare's clock drains. Ordering
    // by timeLeft instead would swap the two chips whenever their times crossed, which reads as
    // jitter; the ring colour already carries urgency at a glance.
    const fares = waitingFares.slice().sort((a, b) => a.slot.index - b.slot.index);

    for (let i = 0; i < fares.length; i++) {
      const fare = fares[i];
      const chip = chipAt(i);
      chip.button.hidden = false;
      chip.setFare(fare);
      chip.wave(elapsed);

      const fraction = Math.max(0, Math.min(1, fare.timeLeft / fare.limit));
      chip.button.style.setProperty('--pct', `${(fraction * 100).toFixed(1)}%`);
      // A VIP's ring stays that fixed purple rather than the ordinary urgency scale — the chip has
      // to agree with the marker out on the map about which rider this is.
      chip.button.style.setProperty('--ring-color',
        fare.vip ? PALETTE.vip : urgencyColorFor(fraction).getStyle());

      chip.render();
    }
    for (let i = fares.length; i < chips.length; i++) {
      chips[i].button.hidden = true;
      chips[i].setFare(null);
    }
  }

  return { update };
}
