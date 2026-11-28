import * as THREE from 'three';
import { PALETTE } from '../palette.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { bakeColor, hash01, propMaterial, unlitMaterial } from '../util/geo.js';

/**
 * The holiday lights, with the snowstorm (game/snow.js): strings of coloured bulbs swagged along
 * the rooflines of most of the city's flat roofs, run down the corners of more than half of those
 * and round the shopfront line of some, scattered through the crowns of about half the trees, a
 * string spiralling the fir in the park (`holidayTree` from city/props.js), and a star on top of it.
 *
 * Two instanced meshes, the bulbs dealt alternately between them, so the whole city costs two draws
 * and a twinkle is one colour per mesh per frame: the two sets breathe against each other. Unlit,
 * and handed to the bloom by main.js, so each bulb carries a glow at play zoom where the bulb itself
 * is two pixels. Placed once at boot; nothing here moves.
 */

const COLORS = ['holidayRed', 'holidayGreen', 'holidayGold', 'holidayBlue', 'holidayWhite'];
/**
 * The share of flat roofs that are strung, picked by a hash of the roof so a seed's city is stable.
 * 0.55 first (Tyler, 2026-11-25: "can we add some more holiday lights on buildings etc?").
 */
const ROOF_SHARE = 0.85;
/** Of the strung buildings, the share that also run a string down each corner to the street. */
const DROP_SHARE = 0.6;
/** And the share with a second ring at the shopfront line, about where the awnings are. */
const STOREY_SHARE = 0.45;
const STOREY_Y = 2.9;
/** Street and park trees with lights in their crowns, and bulbs per square unit of a lobe's radius. */
const TREE_SHARE = 0.45;
const CROWN_DENSITY = 7;
const CROWN_BULB = 0.12;
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
/**
 * The greenery (Tyler, 2026-11-27: "add some garland or tree wreaths to some of the decorated
 * buildings"). Of the strung roofs, the share whose string is wound through fir garland, and the
 * share with a wreath hung on each face under the parapet. Lit and flat-shaded like any prop, not
 * bloomed: it is foliage, and what makes it read is the bulbs glowing over it. One instanced draw
 * each, so the two cost two draws whatever the city.
 */
const GARLAND_SHARE = 0.5;
const WREATH_SHARE = 0.4;
/** Garland: a tuft every so far along the swag, this big, a little in behind the bulbs. */
const TUFT_PITCH = 0.2;
// 0.12 and 0.04 in behind the bulbs first: buried in the cornice, invisible at play zoom.
const TUFT = 0.15;
const GARLAND_OUT = OUT + 0.02;
const GARLAND_DROP = 0.12;
/** Wreath: ring radius and thickness, how far under the deck it hangs, and its stand-off from the wall. */
const WREATH_R = 0.42;
const WREATH_T = 0.14;
const WREATH_DROP = 0.75;
// The ring's own thickness off the wall plus a hair, so its back face never meets the wall.
const WREATH_OUT = WREATH_T + 0.02;
/** Only on faces at least this long, so a narrow tower is not hung with a wreath wider than its bay. */
const WREATH_MIN_FACE = 3;
/** Seconds for one breath of the twinkle. */
const TWINKLE = 1.7;

export function createHolidayLights({ decks = [], tree = null, crowns = [] } = {}) {
  const sets = [[], []];
  const tufts = [];
  const wreaths = [];
  let n = 0;
  const add = (x, y, z, size, color) => { sets[n++ % 2].push({ x, y, z, size, color }); };

  const real = decks.filter((d) => !d.ghost);
  // What a string hung down from (x, z) at height y lands on: the highest other roof under it, or
  // the street. A tower's setback deck stands over a wider podium, and a drop that ignored it would
  // run straight through the podium's roof.
  const floorAt = (x, z, y, self) => {
    let f = 0.3;
    for (const d of real) {
      if (d === self || d.deck >= y || d.deck <= f) continue;
      if (Math.abs(x - d.cx) <= d.cw / 2 + OUT && Math.abs(z - d.cz) <= d.cd / 2 + OUT) f = d.deck;
    }
    return f;
  };
  const ring = (deck, y, sag, garland = false) => {
    const hx = deck.cw / 2 + OUT;
    const hz = deck.cd / 2 + OUT;
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
        add(deck.cx + ax + (bx - ax) * t, y - sag * swag, deck.cz + az + (bz - az) * t, BULB, COLORS[k++ % COLORS.length]);
      }
      if (garland) {
        // The same swag, just under the bulbs, so the string reads as laid along the garland.
        const g = GARLAND_OUT / OUT;
        const tsteps = Math.max(1, Math.round(len / TUFT_PITCH));
        for (let i = 0; i < tsteps; i++) {
          const t = i / tsteps;
          const swag = Math.sin(Math.PI * ((t * hooks) % 1));
          const spin = hash01(e * 13.1 + i, deck.cx + deck.cz);
          tufts.push({
            x: deck.cx + (ax + (bx - ax) * t) * g, y: y - GARLAND_DROP - sag * swag,
            z: deck.cz + (az + (bz - az) * t) * g, spin, dark: i % 3 !== 0,
          });
        }
      }
    }
    return corners;
  };

  for (const deck of real) {
    const pick = hash01(deck.cx * 1.7 + 3.1, deck.cz * 0.9 - 5.3);
    if (pick > ROOF_SHARE) continue;
    const y = deck.deck + 0.02;
    const garland = hash01(deck.cx * 0.37 + 6.1, deck.cz * 1.3 - 2.9) < GARLAND_SHARE;
    const corners = ring(deck, y, SAG, garland);
    // Wreaths on the faces under the parapet, centred, facing out. Not where the roof string already
    // has a shopfront ring below it at the same height (a short building).
    if (deck.deck - WREATH_DROP > 2.2 && hash01(deck.cz * 0.61 - 7.7, deck.cx * 2.1 + 1.3) < WREATH_SHARE) {
      const wy = deck.deck - WREATH_DROP;
      const hx = deck.cw / 2 + WREATH_OUT;
      const hz = deck.cd / 2 + WREATH_OUT;
      if (deck.cd >= WREATH_MIN_FACE) {
        wreaths.push({ x: deck.cx + hx, y: wy, z: deck.cz, yaw: Math.PI / 2 });
        wreaths.push({ x: deck.cx - hx, y: wy, z: deck.cz, yaw: -Math.PI / 2 });
      }
      if (deck.cw >= WREATH_MIN_FACE) {
        wreaths.push({ x: deck.cx, y: wy, z: deck.cz + hz, yaw: 0 });
        wreaths.push({ x: deck.cx, y: wy, z: deck.cz - hz, yaw: Math.PI });
      }
    }
    // Two more draws of the same hash, so which buildings get the extras is stable too.
    if (hash01(deck.cz * 2.3 - 1.7, deck.cx * 1.1 + 8.9) < DROP_SHARE) {
      corners.forEach(([ox, oz], c) => {
        const x = deck.cx + ox;
        const z = deck.cz + oz;
        const bottom = floorAt(x, z, deck.deck, deck) + 0.3;
        const steps = Math.floor((y - bottom) / PITCH);
        for (let i = 1; i <= steps; i++) add(x, y - i * PITCH, z, BULB, COLORS[(i + c) % COLORS.length]);
      });
    }
    if (deck.deck > STOREY_Y + 2 && floorAt(deck.cx, deck.cz, deck.deck, deck) < 0.5
      && hash01(deck.cx * 0.7 - 4.1, deck.cz * 1.9 + 2.2) < STOREY_SHARE) ring(deck, STOREY_Y, SAG * 0.7);
  }

  // The trees: bulbs scattered over the outer, upper face of each lobe of about half the city's
  // trees, on a golden-angle spiral so they spread evenly rather than clump.
  for (const lobe of crowns) {
    if (tree && Math.hypot(lobe.tx - tree.x, lobe.tz - tree.z) < 0.5) continue;
    if (hash01(lobe.tx * 3.1 + 0.7, lobe.tz * 2.7 - 9.1) > TREE_SHARE) continue;
    const r = lobe.r * 1.04;
    const count = Math.max(4, Math.round(CROWN_DENSITY * lobe.r * lobe.r));
    const spin = hash01(lobe.x, lobe.z) * Math.PI * 2;
    for (let i = 0; i < count; i++) {
      const v = 1 - 1.25 * ((i + 0.5) / count); // cos of the polar angle, from the top to a little below the equator
      const s = Math.sqrt(Math.max(0, 1 - v * v));
      const a = spin + i * 2.39996;
      add(lobe.x + Math.cos(a) * s * r * 1.05, lobe.y + v * r * 0.9, lobe.z + Math.sin(a) * s * r * 1.05,
        CROWN_BULB, COLORS[(i * 3 + Math.floor(spin * 7)) % COLORS.length]);
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

  // The greenery: two instanced props. A tuft is a squashed icosahedron; the wreath is a torus with
  // a bow at its foot, baked into one geometry and stood in the face's plane (local +z out).
  const greenery = [];
  if (tufts.length) {
    const tuftGeo = bakeColor(new THREE.IcosahedronGeometry(1, 0), new THREE.Color(0xffffff));
    tuftGeo.deleteAttribute('uv');
    const mesh = new THREE.InstancedMesh(tuftGeo, propMaterial(), tufts.length);
    const q = new THREE.Quaternion();
    const e = new THREE.Euler();
    const s = new THREE.Vector3();
    const p = new THREE.Vector3();
    tufts.forEach((tf, j) => {
      q.setFromEuler(e.set(tf.spin * 2, tf.spin * 6.3, tf.spin * 4));
      s.set(TUFT * 1.3, TUFT, TUFT * 1.1);
      matrix.compose(p.set(tf.x, tf.y, tf.z), q, s);
      mesh.setMatrixAt(j, matrix);
      mesh.setColorAt(j, colour.set(PALETTE[tf.dark ? 'garlandDark' : 'garlandLight']));
    });
    mesh.name = 'holiday-garland';
    greenery.push(mesh);
  }
  if (wreaths.length) {
    // `bakeColor` hands back a new, non-indexed geometry for an indexed one: use what it returns.
    const ringGeo = bakeColor(new THREE.TorusGeometry(WREATH_R, WREATH_T, 5, 14), new THREE.Color(PALETTE.wreathGreen));
    ringGeo.deleteAttribute('uv');
    // The bow: two flat boxes splayed into a V at the bottom of the ring, and a knot, standing
    // proud of the ring's front so it is never coplanar with it.
    const bowParts = [-1, 1].map((side) => {
      const b = new THREE.BoxGeometry(0.26, 0.16, 0.06);
      b.rotateZ(side * 0.45);
      b.translate(side * 0.13, -WREATH_R - 0.02, WREATH_T + 0.04);
      return b;
    });
    const knot = new THREE.BoxGeometry(0.1, 0.12, 0.08);
    knot.translate(0, -WREATH_R - 0.02, WREATH_T + 0.06);
    const bow = bakeColor(mergeGeometries([...bowParts, knot].map((g) => { g.deleteAttribute('uv'); return g; })),
      new THREE.Color(PALETTE.wreathBow));
    const wreathGeo = mergeGeometries([ringGeo, bow]);
    const mesh = new THREE.InstancedMesh(wreathGeo, propMaterial(), wreaths.length);
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    const one = new THREE.Vector3(1, 1, 1);
    const p = new THREE.Vector3();
    wreaths.forEach((w, j) => {
      matrix.compose(p.set(w.x, w.y, w.z), q.setFromAxisAngle(up, w.yaw), one);
      mesh.setMatrixAt(j, matrix);
    });
    mesh.name = 'holiday-wreaths';
    greenery.push(mesh);
  }
  for (const mesh of greenery) {
    // Out of the snow cover: it is keyed off up-facing faces, and a tuft or a torus is half
    // up-facing, so under the cover a wreath came out a grey ring and the garland white rope.
    mesh.material.userData.snow = false;
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.receiveShadow = true;
  }

  const group = new THREE.Group();
  group.name = 'holiday-lights';
  group.add(...meshes, ...greenery, ...(star ? [star] : []));

  let t = 0;
  return {
    group,
    meshes,
    greenery,
    tufts: tufts.length,
    wreaths: wreaths.length,
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
