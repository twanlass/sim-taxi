// The then-and-now slide's first commit, drawn flat: every lit material in that build's scene swapped for an unlit
// one in the same colour, on a white page, so there is no shading and no shadow — not how the first build looked, but
// simpler than it, which is the point of the slide. The build is a prebuilt bundle
// (public/talk/first/) and can't be edited, but it publishes `window.__taxi`, which leads to its
// scene. The replacements are made with this page's three, not the build's (it doesn't publish
// one): the renderer goes by a material's flags and type rather than its class, the same reason
// the title's text layer can be drawn into the game from out here.
import * as THREE from 'three';
import { unlitMaterial } from '../util/geo.js';

/** The build's scene, found by walking out from whatever `__taxi` holds to an Object3D and up. */
function findScene(taxi) {
  const seen = new Set();
  let layer = Object.values(taxi);
  for (let depth = 0; depth < 3 && layer.length; depth++) {
    const next = [];
    for (const v of layer) {
      if (!v || typeof v !== 'object' || seen.has(v)) continue;
      seen.add(v);
      if (v.isObject3D) {
        let o = v;
        while (o.parent) o = o.parent;
        if (o.isScene) return o;
      }
      if (!v.isObject3D) next.push(...Object.values(v));
    }
    layer = next;
  }
  return null;
}

/**
 * Flatten what's in the scene now, and keep doing it: cars, skid marks and the police turn up after
 * the first frame. Each source material gets one replacement, shared, so the frame compiles a
 * handful of programs rather than one per mesh. Returns false when the scene can't be found yet.
 */
export function flattenScene(w) {
  const scene = w.__taxi && findScene(w.__taxi);
  if (!scene) return false;
  const flat = new Map();
  const unlit = (m) => {
    if (!m || m.isMeshBasicMaterial || !(m.isMeshStandardMaterial || m.isMeshLambertMaterial || m.isMeshPhongMaterial || m.isMeshToonMaterial)) return m;
    if (!flat.has(m)) {
      flat.set(m, unlitMaterial({
        color: new THREE.Color(m.color.r, m.color.g, m.color.b), map: m.map, vertexColors: m.vertexColors, side: m.side,
        transparent: m.transparent, opacity: m.opacity, alphaTest: m.alphaTest,
      }));
    }
    return flat.get(m);
  };
  const pass = () => scene.traverse((o) => {
    if (!o.isMesh) return;
    // Its sky is a 1800-unit mesh, not the background, and drew beige behind the city.
    if (o.name === 'sky') { o.visible = false; return; }
    o.castShadow = false;
    o.receiveShadow = false;
    o.material = Array.isArray(o.material) ? o.material.map(unlit) : unlit(o.material);
  });
  // On white, like the rest of the deck, rather than the build's own sky; its fog fades the
  // island's edge into the same white.
  scene.background = new THREE.Color(0xffffff);
  scene.fog?.color.set(0xffffff);
  pass();
  w.setInterval(pass, 500);
  return true;
}
