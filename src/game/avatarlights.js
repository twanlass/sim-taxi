import * as THREE from 'three';

// Shared by every mini WebGL context that pictures something out of the city — the tutorial
// bubble's avatar (game/tutorial.js) and the rider-finder chips (game/riderfinder.js) — so a taxi
// or a rider drawn in a 38px disc is lit by the same afternoon as the one on screen, not by a
// studio rig of its own.

/**
 * Mirror the city's sun + hemisphere fill into another scene. Two lights with the same colours,
 * intensities and — for the sun — the same world position, which is all a directional light's
 * direction depends on: `target` aims its own copy at its own origin, so copying the position
 * copies the angle exactly.
 *
 * An Object3D has one parent, so the city's actual lights can't simply be re-added here — this
 * makes fresh ones and hands back a `sync()` to copy the live values across each frame, which is
 * what carries a day/night cycle toggled from the ⚙️ panel into every mirror instead of leaving
 * them stranded at whatever hour they were built.
 */
export function mirrorSceneLights(target, sun, hemi) {
  const avatarSun = new THREE.DirectionalLight(sun.color.getHex(), sun.intensity);
  const avatarHemi = new THREE.HemisphereLight(hemi.color.getHex(), hemi.groundColor.getHex(),
    hemi.intensity);
  target.add(avatarSun, avatarSun.target, avatarHemi);
  return function sync() {
    avatarSun.position.copy(sun.position);
    avatarSun.color.copy(sun.color);
    avatarSun.intensity = sun.intensity;
    avatarHemi.color.copy(hemi.color);
    avatarHemi.groundColor.copy(hemi.groundColor);
    avatarHemi.intensity = hemi.intensity;
  };
}
