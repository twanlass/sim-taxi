import * as THREE from 'three';
import { createPerson } from '../geometry/person.js';
import { fareStageColour } from './timerring.js';

// A HUD shortcut bottom-right, mirror of Loco Mode.
//
// A waiting rider is a handful of pixels among a hundred buildings, and on a phone the whole city
// doesn't fit in one screen. This button surfaces the waiting fare — same animated figure the
// player is hunting for — and a tap snaps the camera to frame them.
//
// The figure is rendered as 3D into a small canvas so it moves with the same wave that plays on
// the kerb; the countdown ring around it is a plain CSS conic-gradient, driven from the same
// four-stage palette as the fare's travelling timer so the two read as the same clock.

const SIZE = 56;      // matches the visible disc inside the button

export function createRiderFinder({ onTap }) {
  const button = document.getElementById('rider-finder');
  const canvas = button?.querySelector('canvas');
  if (!button || !canvas) return { update: () => {} };

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
  let elapsed = 0;
  let visible = false;

  function setVisible(next) {
    if (visible === next) return;
    visible = next;
    button.hidden = !next;
  }
  setVisible(false);

  function update(dt, fare) {
    // The button only surfaces a *waiting* rider — the whole point is helping the player find one.
    // A fare aboard is following the taxi and doesn't need a beacon.
    if (!fare || fare.stage !== 'waiting') {
      setVisible(false);
      currentFare = null;
      return;
    }

    setVisible(true);
    currentFare = fare;
    elapsed += dt;
    person.wave(elapsed);

    const fraction = Math.max(0, Math.min(1, fare.timeLeft / fare.limit));
    button.style.setProperty('--pct', `${(fraction * 100).toFixed(1)}%`);
    button.style.setProperty('--ring-color', fareStageColour(fraction).getStyle());

    renderer.render(scene, camera);
  }

  button.addEventListener('click', () => {
    if (currentFare && onTap) onTap(currentFare);
  });

  return { update };
}
