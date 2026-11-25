import * as THREE from 'three';
import { PALETTE } from '../palette.js';
import { hash01, unlitMaterial } from '../util/geo.js';

/**
 * The holiday lights, with the snowstorm (game/snow.js): strings of coloured bulbs swagged along
 * the rooflines of about half the city's flat roofs, a string spiralling the fir in the park
 * (`holidayTree` from city/props.js), and a star on top of it.
 *
 * Two instanced meshes, the bulbs dealt alternately between them, so the whole city costs two draws
 * and a twinkle is one colour per mesh per frame: the two sets breathe against each other. Unlit,
 * and handed to the bloom by main.js, so each bulb carries a glow at play zoom where the bulb itself
 * is two pixels. Placed once at boot; nothing here moves.
 */

const COLORS = ['holidayRed', 'holidayGreen', 'holidayGold', 'holidayBlue', 'holidayWhite'];
/** The share of flat roofs that are strung, picked by a hash of the roof so a seed's city is stable. */
const ROOF_SHARE = 0.55;
/** Bulb spacing along a roofline, and the hooks the string hangs between. */
const PITCH = 0.55;
const HOOK = 2.2;
const SAG = 0.16;
/** Out past the parapet's cornice (`lippedCap`, +0.18 each side), so the string hangs on the face. */
const OUT = 0.24;
// 0.11 first: two pixels at play zoom and lost against the cornice. 0.15 reads as a string of lamps.
const BULB = 0.15;
/** The fir's string: turns round the tree, and bulbs on it. */
const TURNS = 6;
const TREE_BULBS = 150;
const TREE_BULB = 0.17;
/** Seconds for one breath of the twinkle. */
const TWINKLE = 1.7;

export function createHolidayLights({ decks = [], tree = null } = {}) {
  const sets = [[], []];
  let n = 0;
  const add = (x, y, z, size, color) => { sets[n++ % 2].push({ x, y, z, size, color }); };

  for (const deck of decks) {
    if (hash01(deck.cx * 1.7 + 3.1, deck.cz * 0.9 - 5.3) > ROOF_SHARE) continue;
    const hx = deck.cw / 2 + OUT;
    const hz = deck.cd / 2 + OUT;
    const y = deck.deck + 0.02;
    const corners = [[-hx, -hz], [hx, -hz], [hx, hz], [-hx, hz]];
    let k = 0;
    for (let e = 0; e < 4; e++) {
      const [ax, az] = corners[e];
      const [bx, bz] = corners[(e + 1) % 4];
      const len = Math.hypot(bx - ax, bz - az);
      const hooks = Math.max(1, Math.round(len / HOOK));
      const steps = Math.max(1, Math.round(len / PITCH));
      for (let i = 0; i < steps; i++) {
        const t = i / steps;
        const swag = Math.sin(Math.PI * ((t * hooks) % 1));
        add(deck.cx + ax + (bx - ax) * t, y - SAG * swag, deck.cz + az + (bz - az) * t, BULB, COLORS[k++ % COLORS.length]);
      }
    }
  }

  let star = null;
  if (tree) {
    const bottom = tree.tiers[0].y0 + 0.3;
    const span = tree.top - 0.6 - bottom;
    for (let i = 0; i < TREE_BULBS; i++) {
      const t = i / (TREE_BULBS - 1);
      const y = bottom + span * t;
      // The cone's own radius at this height: the tier it is in, measured down from its tip.
      let r = 0.3;
      for (const tier of tree.tiers) {
        if (y >= tier.y0 && y <= tier.y0 + tier.h) r = Math.max(r, tier.r * (1 - (y - tier.y0) / tier.h));
      }
      const a = t * TURNS * Math.PI * 2;
      add(tree.x + Math.cos(a) * (r + 0.08), y, tree.z + Math.sin(a) * (r + 0.08), TREE_BULB, COLORS[i % COLORS.length]);
    }
    const starGeo = new THREE.OctahedronGeometry(0.5, 0);
    starGeo.scale(1, 1.25, 0.45);
    star = new THREE.Mesh(starGeo, unlitMaterial({ color: PALETTE.holidayStar }));
    star.position.set(tree.x, tree.top + 0.35, tree.z);
    star.name = 'holiday-star';
  }

  const geometry = new THREE.OctahedronGeometry(1, 0);
  const matrix = new THREE.Matrix4();
  const colour = new THREE.Color();
  const meshes = sets.filter((set) => set.length).map((set, i) => {
    const mesh = new THREE.InstancedMesh(geometry, unlitMaterial({ color: 0xffffff }), set.length);
    set.forEach((b, j) => {
      matrix.makeScale(b.size, b.size * 1.3, b.size).setPosition(b.x, b.y, b.z);
      mesh.setMatrixAt(j, matrix);
      mesh.setColorAt(j, colour.set(PALETTE[b.color]));
    });
    mesh.instanceMatrix.needsUpdate = true;
    mesh.instanceColor.needsUpdate = true;
    mesh.name = `holiday-bulbs-${i}`;
    return mesh;
  });

  const group = new THREE.Group();
  group.name = 'holiday-lights';
  group.add(...meshes, ...(star ? [star] : []));

  let t = 0;
  return {
    group,
    meshes,
    star,
    count: sets[0].length + sets[1].length,
    update(dt) {
      t += dt;
      const w = 0.5 + 0.5 * Math.sin((t / TWINKLE) * Math.PI * 2);
      meshes.forEach((mesh, i) => mesh.material.color.setScalar(0.55 + 0.45 * (i ? 1 - w : w)));
      if (star) star.rotation.y = t * 0.6;
    },
  };
}
