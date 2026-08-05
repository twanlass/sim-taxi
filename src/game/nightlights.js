import * as THREE from 'three';
import { glowMaterial } from '../util/geo.js';

/**
 * The city's own lights: the windows that come on in the towers, and the street lamps with their
 * cones of lit air and their pools on the tarmac.
 *
 * The geometry is built where the things themselves are built — `city/buildings.js` and
 * `city/props.js` hand back a merged BufferGeometry each. This module owns the two things that
 * are *not* the city's business: the unlit materials they wear, and the single opacity that fades
 * every one of them in at dusk and out at dawn.
 *
 * Two materials, not one, because a lit window and a pool of light are different kinds of thing:
 *
 * - **Windows blend normally.** A window is a surface with a light behind it, and it should read
 *   as that surface at its own colour — additive would let the dark facade underneath show
 *   through and turn every pane into a smear of the building's paint.
 * - **Lamps blend additively.** A pool on the road is light arriving somewhere, not paint. It has
 *   to brighten the asphalt, the lane markings and the crosswalk under it without hiding any of
 *   them, and that is what additive is.
 *
 * Both fade with `lit` from the daylight curve rather than switching. A city whose lights all snap
 * on in one frame reads as a bug; over the ~40 seconds of dusk at the default day length, windows
 * appearing while the sky is still going down reads as evening.
 */
export function createNightLights(scene, { windows = null, glow = null } = {}) {
  const group = new THREE.Group();
  group.name = 'nightLights';

  const paneMaterial = glowMaterial({ additive: false });
  const lampMaterial = glowMaterial({ additive: true });

  const add = (geometry, material, name) => {
    if (!geometry) return null;
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = name;
    // Nothing here is lit, and nothing here casts. A lit window that threw a shadow would be
    // shadowing the building it is a hole in.
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    group.add(mesh);
    return mesh;
  };

  const panes = add(windows, paneMaterial, 'litWindows');
  const lamps = add(glow, lampMaterial, 'streetLights');

  scene.add(group);

  /**
   * `lit` is the daylight curve's own 0..1 — see game/daylight.js. Below the threshold the whole
   * group goes invisible rather than being drawn at opacity ~0: these are a few thousand
   * transparent triangles, and skipping them outright is free for the twelve hours a day they
   * contribute nothing to.
   */
  function setLit(lit) {
    const k = THREE.MathUtils.clamp(lit, 0, 1);
    group.visible = k > 0.01;
    if (!group.visible) return;
    paneMaterial.opacity = k;
    // The street lamps lag the windows slightly and never quite reach full strength in the same
    // way. They are additive over a road that is still bright at dusk, and coming up at full rate
    // there just washes the tarmac out before it is dark enough for the light to have anywhere to
    // land. Squaring holds them back until the sky has actually gone.
    lampMaterial.opacity = k * k;
  }

  setLit(0);

  return { group, setLit, panes, lamps };
}
