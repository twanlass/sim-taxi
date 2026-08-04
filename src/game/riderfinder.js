import * as THREE from 'three';
import { createPerson } from '../geometry/person.js';
import { urgencyColorFor } from './urgency.js';

// A HUD stack in the bottom-left, above the Loco Mode pill, so both controls sit under the same
// thumb.
//
// A waiting rider is a handful of pixels among a hundred buildings, and on a phone the whole city
// doesn't fit in one screen. Each waiting fare gets its own chip here — same animated figure the
// player is hunting for, with the fare's own countdown ring around it — and a tap snaps the
// camera onto that rider. Double-tap the chip to actually route the taxi at that fare, so the
// dispatch loop works without ever having to find the pin on the map. Two clocks on the kerb
// means two chips on screen; the column grows upward so the bottom slot stays put next to the
// Loco Mode pill and extra riders pile above it.
//
// One WebGL renderer per chip. MAX_FARES caps the pool at three, so the extra contexts are well
// under any browser limit. Cheaper alternatives (one renderer, blit to N canvases) exist but the
// figure and the waiting person are the same little scene, so keeping the mini-renderer symmetric
// with the main one keeps this module short.
//
// The chip disc is a plain dark bubble the three.js canvas draws the figure onto; the countdown
// ring around it is a CSS conic-gradient driven from game/urgency.js — the same scale as the bar
// over the rider on the map and the ring that rides with the taxi, so all three read as one clock.

const SIZE = 38;      // matches the visible chip disc inside the button
const DOUBLE_TAP_MS = 320;   // upper bound of a comfortable double tap; browser `dblclick` won't
                             // fire reliably from touch, so we detect the pair ourselves.

function createChip(onTap, onDoubleTap) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'rider-finder-chip';
  button.setAttribute('aria-label', 'Snap camera to waiting rider');

  const chip = document.createElement('span');
  chip.className = 'chip';
  const canvas = document.createElement('canvas');
  canvas.width = SIZE;
  canvas.height = SIZE;
  chip.appendChild(canvas);
  button.appendChild(chip);

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(SIZE, SIZE, false);
  renderer.setClearColor(0x000000, 0);

  const scene = new THREE.Scene();

  // Neutral lighting. The main scene's sun rakes across the city; here the figure is looking
  // straight at the camera and needs its front lit, not its side.
  scene.add(new THREE.AmbientLight(0xffffff, 0.85));
  const key = new THREE.DirectionalLight(0xffffff, 0.55);
  key.position.set(2, 4, 3);
  scene.add(key);

  const person = createPerson();
  scene.add(person.group);

  // Ortho frustum sized to fit the ~3.2-unit-tall figure with a little air. Looking slightly
  // down and from the front so the wave arm is clearly visible; the character faces +X, so the
  // camera sits on +X and looks back at the origin.
  const camera = new THREE.OrthographicCamera(-2.2, 2.2, 2.7, -1.5, 0.1, 40);
  camera.position.set(4.6, 3.2, 1.8);
  camera.lookAt(0, 1.55, 0);

  let currentFare = null;
  // Manual double-tap detection. The first tap always snaps the camera (single-tap behaviour is
  // unchanged); a second tap within DOUBLE_TAP_MS on the same chip fires the routing callback.
  // We still snap on the first tap of a pair — the camera move is cheap and reversible, and
  // suppressing it would make a mistimed double-tap feel like the first tap was eaten.
  let lastTap = 0;
  button.addEventListener('click', () => {
    if (!currentFare) return;
    const now = performance.now();
    if (onDoubleTap && now - lastTap < DOUBLE_TAP_MS) {
      onDoubleTap(currentFare);
      lastTap = 0;
      return;
    }
    lastTap = now;
    if (onTap) onTap(currentFare);
  });

  return {
    button,
    render: () => renderer.render(scene, camera),
    wave: (t) => person.wave(t),
    setFare(fare) { currentFare = fare; },
  };
}

export function createRiderFinder({ onTap, onDoubleTap }) {
  const stack = document.getElementById('rider-finder-stack');
  if (!stack) return { update: () => {} };

  const chips = [];
  let elapsed = 0;

  function chipAt(i) {
    if (chips[i]) return chips[i];
    const chip = createChip(onTap, onDoubleTap);
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
      chip.button.style.setProperty('--ring-color', urgencyColorFor(fraction).getStyle());

      chip.render();
    }
    for (let i = fares.length; i < chips.length; i++) {
      chips[i].button.hidden = true;
      chips[i].setFare(null);
    }
  }

  return { update };
}
