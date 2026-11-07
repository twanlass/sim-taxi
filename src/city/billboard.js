import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { bakeColor, hash01, propMaterial, stampEntry, unlitMaterial } from '../util/geo.js';
import { color } from '../palette.js';
import { clearOf } from './vetclinic.js';
import { ADS, posterTexture } from './billboardart.js';

// The rooftop billboards: up to two flat roofs per city carry a big steel-legged advertising hoarding,
// the kind that stands over a low warehouse beside an expressway. Tyler asked for "a fun little
// billboard on a roof top" on 2026-11-04.
//
// **What they say.** Two ads, one board each, on two roofs at least `APART` from each other: the
// robo-taxis' teaser (the council approved them; they arrive Monday, as the intro tells it) and
// Dub Burger, the city's own drive-through advertising itself. The posters are vector art painted on a canvas
// (city/billboardart.js), where the layouts and why they are sized as they are live. The steel is a
// dark bottle green so the frame stands off the grey roof, and three lamps on the catwalk throw a
// faint beam each up onto the paper.
//
// **Nothing about the building changes**, exactly as with the vet clinic: `createBuildings` builds
// every tower, and `chooseBillboardSite` picks a roof afterwards by its own rule, spending no draw.
// `?billboard=classic` leaves it off.
//
// **Which roof.** The widest flat deck in the city, because the board stands across the deck's
// *diagonal* — its face turned square to the camera, which looks down +X+Z and never turns, so a
// board along a street would be read at 45° and lose a third of its width to foreshortening. On a
// diagonal a board W wide needs W/√2 of deck in both x and z, and the full-block warehouses
// (10.3 square, four units tall) give the most. Low is good rather than a compromise: a hoarding on
// a four-unit roof still tops out around nine, and it hides less of the street up-screen of it.
// Then the sightline: a ray off each corner of the face, marched towards the camera through every
// other tower (`clearOf`, city/vetclinic.js). It goes in the sightline field too (main.js), so no
// fare is ever put on a corner it hides.

/** `?billboard=classic` — the roof stays a bare roof. */
export const BILLBOARD_CLASSIC = typeof location !== 'undefined'
  && new URLSearchParams(location.search).get('billboard') === 'classic';

/** The board at its biggest, in world units. 8 is ~62px at play zoom, a bit under half a block. */
const MAX_W = 8;
/** ...and at its smallest. Under this the big word drops below eight pixels tall and stops reading. */
const MIN_W = 5.6;
/** Height over width: a 48-sheet poster is 2:1, and a little taller leaves room for the strap line. */
const ASPECT = 0.42;
/** Deck to the bottom of the board: over the tallest plant room (1.6) with a gap you can see. */
const LIFT = 2.0;
/** How far the board may hang past the roof's lip at each end. Real hoardings overhang. */
const OVERHANG = 0.5;
const LIP = 0.28;               // the roof's lip (LIP_W in buildings.js)
const PANEL_D = 0.2;            // the panel's thickness
/** How much of the art lights itself (`emissiveIntensity`), for the lamps on the catwalk. */
const POSTER_GLOW = 0.22;
const BORDER = 0.18;            // the steel frame showing round the poster
const POST = 0.16;              // the posts' section
/** How far apart two boards' feet have to be: about a block and a half, so they never share a view. */
const APART = 30;
const RAKE = 1.2;               // how far behind the board the raking braces land on the deck

/** Face normal and the board's own +X, in world space: square to the camera. */
const OUT = new THREE.Vector3(1, 0, 1).normalize();
const ALONG = new THREE.Vector3(1, 0, -1).normalize();

// --- The poster -------------------------------------------------------------------------------

/**
 * The poster's paper, in the board's own frame: centred at the origin, facing +Z, 0.01 proud of the
 * panel's front at z = 0. White vertex colour under the art's texture (city/billboardart.js), and
 * the UVs the texture needs, which `bakeColor` would strip.
 */
function paperGeometry(w, h) {
  const geo = new THREE.PlaneGeometry(w - 2 * BORDER, h - 2 * BORDER).toNonIndexed();
  geo.translate(0, 0, 0.01);
  const n = geo.attributes.position.count;
  geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(n * 3).fill(1), 3));
  return geo;
}

/**
 * A lamp's beam: an open cone from the lamp up onto the poster, additive, bright at the lamp and
 * gone at the far end. Where it passes behind the paper the depth test cuts it, which is exactly
 * the shape a beam hitting a wall makes. In the board frame, apex at `from`, aimed at `to`.
 */
function beamGeometry(from, to, radius) {
  const len = from.distanceTo(to);
  const geo = new THREE.CylinderGeometry(radius, 0.08, len, 14, 4, true).toNonIndexed();
  geo.translate(0, len / 2, 0);
  const pos = geo.attributes.position;
  const colors = new Float32Array(pos.count * 3);
  const c = new THREE.Color(color('billboardBeam'));
  for (let i = 0; i < pos.count; i++) {
    const t = pos.getY(i) / len;                       // 0 at the lamp, 1 at the far end
    const k = (1 - t) ** 3;
    colors.set([c.r * k, c.g * k, c.b * k], i * 3);
  }
  for (const name of Object.keys(geo.attributes)) if (name !== 'position') geo.deleteAttribute(name);
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  const dir = new THREE.Vector3().subVectors(to, from).normalize();
  geo.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir));
  geo.translate(from.x, from.y, from.z);
  return geo;
}

// --- The structure ----------------------------------------------------------------------------

/** A square-section strut from `a` to `b`. */
function strut(a, b, size, col) {
  const len = a.distanceTo(b);
  const geo = new THREE.BoxGeometry(size, len, size);
  const dir = new THREE.Vector3().subVectors(b, a).normalize();
  geo.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir));
  const mid = new THREE.Vector3().addVectors(a, b).multiplyScalar(0.5);
  geo.translate(mid.x, mid.y, mid.z);
  return bakeColor(geo, col);
}

/** Board-frame (u along, y up, v out of the face) to world, about the board's foot `at`. */
function toWorld(at, u, y, v) {
  return new THREE.Vector3(
    at.x + ALONG.x * u + OUT.x * v, y, at.z + ALONG.z * u + OUT.z * v,
  );
}

// --- Choosing the roof ------------------------------------------------------------------------

/** Is the rectangle round `p` free of everything on the deck? */
function free(deck, p, r) {
  return deck.keep.every((k) => p.x + r < k.x0 || p.x - r > k.x1 || p.z + r < k.z0 || p.z - r > k.z1);
}

/**
 * Pick the city's billboard roofs from the towers `createBuildings` built: one per ad in `ADS`
 * (city/billboardart.js), widest first, as many as fit — possibly none.
 *
 * `taken` is decks already spoken for: the helipad and the vet's. Ties go by hash, after
 * everything else is decided, so it spends no draw and moves nothing.
 */
export function chooseBillboardSite(towers, taken = []) {
  const candidates = [];
  for (const t of towers) {
    const deck = t.deck;
    if (!deck || taken.includes(deck)) continue;
    // The board's footprint across the diagonal: W/√2 in each of x and z, inside the lip, plus
    // what it may hang past it.
    const room = Math.min(deck.cw, deck.cd) - 2 * LIP;
    const w = Math.min(MAX_W, (room + 2 * OVERHANG) * Math.SQRT2 - 2 * POST);
    if (w < MIN_W) continue;
    const h = w * ASPECT;
    // The posts: under the board's ends where the deck allows, drawn in where it does not. A rear
    // brace foot at (u, -RAKE) on the diagonal is (u + RAKE)/√2 out along one axis, so that is
    // what has to stay inside the lip. Drawn in, the board's ends cantilever, as real ones do.
    const half = Math.min(w / 2 - 0.5, (room / 2 - 0.15) * Math.SQRT2 - RAKE);
    if (half < 1.2) continue;
    // The foot of the board: the deck's centre, slid if the plant room is in the way of a post or a
    // brace — back off the camera first, then along the board.
    let at = null;
    const tries = [[0, 0], [-0.6, 0], [0.6, 0], [-1.2, 0], [0, 0.8], [0, -0.8], [-0.6, 0.8], [-0.6, -0.8],
      [-1.2, 0.8], [-1.2, -0.8], [0, 1.6], [0, -1.6], [-1.8, 0]];
    for (const [back, side] of tries) {
      const foot = { x: deck.cx + OUT.x * back + ALONG.x * side, z: deck.cz + OUT.z * back + ALONG.z * side };
      const feet = [-half, half].flatMap((u) => [toWorld(foot, u, 0, 0), toWorld(foot, u, 0, -RAKE)]);
      const inside = feet.every((p) => Math.abs(p.x - deck.cx) < deck.cw / 2 - LIP - 0.15
        && Math.abs(p.z - deck.cz) < deck.cd / 2 - LIP - 0.15);
      // ...and the board's own ends no further past the edge than `OVERHANG`.
      const tips = [-w / 2, w / 2].map((u) => toWorld(foot, u, 0, 0));
      const hung = tips.every((p) => Math.abs(p.x - deck.cx) < deck.cw / 2 + OVERHANG
        && Math.abs(p.z - deck.cz) < deck.cd / 2 + OVERHANG);
      if (inside && hung && feet.every((p) => free(deck, p, 0.2))) { at = foot; break; }
    }
    if (!at) continue;
    const y0 = deck.deck + LIFT;
    const corners = [-w / 2, w / 2].flatMap((u) => [y0, y0 + h].map((y) => toWorld(at, u, y, 0.2)));
    if (!corners.every((p) => clearOf(towers, t, p))) continue;
    candidates.push({ tower: t, at, w, h, y0, half });
  }
  // The widest boards win; among equals (every full-block warehouse gives MAX_W) a hash orders
  // them. Then one per ad, each at least `APART` from the boards already placed, so the two never
  // share a view: one is a landmark, two side by side is a hoarding.
  const sx = candidates.reduce((n, c) => n + c.tower.cx, 0);
  const sz = candidates.reduce((n, c) => n + c.tower.cz, 0);
  const order = candidates.map((c, i) => ({ c, key: -c.w * 10 + hash01(sx * 0.53 + i, sz * 0.29) }))
    .sort((a, b) => a.key - b.key).map((o) => o.c);
  const chosen = [];
  for (const c of order) {
    if (chosen.length === ADS.length) break;
    if (chosen.some((o) => Math.hypot(o.at.x - c.at.x, o.at.z - c.at.z) < APART)) continue;
    chosen.push(c);
  }
  return chosen.map(({ tower, at, w, h, y0, half }, i) => {
    // The birds roost on decks and walk round what stands on them (game/birds.js): the strip the
    // posts and braces occupy.
    const ends = [toWorld(at, -half, 0, 0.1), toWorld(at, half, 0, 0.1), toWorld(at, -half, 0, -RAKE),
      toWorld(at, half, 0, -RAKE)];
    tower.deck.keep.push({
      x0: Math.min(...ends.map((p) => p.x)), x1: Math.max(...ends.map((p) => p.x)),
      z0: Math.min(...ends.map((p) => p.z)), z1: Math.max(...ends.map((p) => p.z)),
    });
    return {
      ad: ADS[i], at, w, h, y0, half, deck: tower.deck.deck,
      anchor: { x: tower.cx, z: tower.cz, rand: hash01(tower.cx, tower.cz) },
      // Where to point a camera: the middle of the face.
      focus: toWorld(at, 0, y0 + h / 2, 0),
    };
  });
}

// --- Building it ------------------------------------------------------------------------------

/**
 * The billboard: the steel (posts, braces, the panel and its catwalk, lit), the poster (lit, its own
 * mesh because it receives shadow but does not cast — paper 0.01 off a panel that casts would
 * shadow itself, see `sinkShadowCaster` in game/scene.js), and the three lamps over it (unlit, a
 * light). All stamped for the entrance wave with the tower's own anchor so it rises with its roof.
 */
export function createBillboard(site) {
  const { at, w, h, y0, half, anchor } = site;
  const stamp = (geo) => stampEntry(geo, anchor.x, anchor.z, anchor.rand);
  const yaw = Math.atan2(OUT.x, OUT.z);              // local +Z onto OUT
  const place = (geo, v = 0) => {
    geo.rotateY(yaw);
    geo.translate(at.x + OUT.x * v, y0 + h / 2, at.z + OUT.z * v);
    return geo;
  };

  const steel = color('billboardSteel');
  const deck = site.deck;
  const steelParts = [];
  // The panel, its front face at v = 0.
  steelParts.push(place(bakeColor(new THREE.BoxGeometry(w, h, PANEL_D), color('billboardBack')), -PANEL_D / 2));
  // Two posts behind it, from the deck to just under its top edge, and a raking brace off each.
  for (const u of [-half, half]) {
    const foot = toWorld(at, u, deck, -PANEL_D - POST / 2);
    steelParts.push(strut(foot, toWorld(at, u, y0 + h - 0.3, -PANEL_D - POST / 2), POST, steel));
    steelParts.push(strut(toWorld(at, u, deck, -RAKE), toWorld(at, u, y0 + h * 0.45, -PANEL_D - POST), POST * 0.8, steel));
  }
  // A cross rail behind the panel's foot, tying the posts.
  steelParts.push(strut(toWorld(at, -half, y0 + 0.2, -PANEL_D - POST * 1.5),
    toWorld(at, half, y0 + 0.2, -PANEL_D - POST * 1.5), POST * 0.7, steel));
  // The catwalk along the foot, a grate the lamps stand on, and its brackets back to the posts.
  const walk = new THREE.BoxGeometry(w * 0.96, 0.06, 0.55);
  walk.translate(0, -h / 2 - 0.08, 0.3);
  steelParts.push(place(bakeColor(walk, color('billboardWalk'))));
  // The lamp arms: three goosenecks up off the catwalk's front edge, leaning in over the poster.
  const lampAt = [-w / 3, 0, w / 3];
  const lamps = [];
  for (const u of lampAt) {
    const base = toWorld(at, u, y0 - 0.06, 0.55);
    const head = toWorld(at, u, y0 + 0.55, 0.85);
    steelParts.push(strut(base, head, 0.06, steel));
    const shade = new THREE.BoxGeometry(0.34, 0.12, 0.2);
    shade.rotateX(-0.6);
    shade.translate(0, 0, 0);
    const hood = bakeColor(shade, steel);
    hood.rotateY(yaw);
    hood.translate(head.x, head.y + 0.06, head.z);
    steelParts.push(hood);
    // The lamp glass on the hood's underside, facing the poster.
    const glass = new THREE.BoxGeometry(0.26, 0.04, 0.14);
    glass.rotateX(-0.6);
    const lamp = bakeColor(glass, color('billboardLamp'));
    lamp.rotateY(yaw);
    lamp.translate(head.x, head.y - 0.01, head.z);
    lamps.push(lamp);
  }
  steelParts.forEach(stamp);
  const shell = new THREE.Mesh(mergeGeometries(steelParts, false), propMaterial());
  steelParts.forEach((p) => p.dispose());
  shell.castShadow = true;
  shell.receiveShadow = true;
  shell.name = 'billboard-steel';

  // The art as the paper's map and, faintly, as its emissive: lit from the catwalk, a poster reads
  // a step brighter than the roof it stands on, which is most of what makes it a billboard. With
  // no canvas (the headless tools) it is plain paper.
  const paperMaterial = propMaterial();
  const art = posterTexture(site.ad);
  if (art) {
    paperMaterial.map = art;
    paperMaterial.emissive = new THREE.Color(0xffffff);
    paperMaterial.emissiveMap = art;
    paperMaterial.emissiveIntensity = POSTER_GLOW;
  } else {
    paperMaterial.color = new THREE.Color(color('billboardPaper'));
  }
  const poster = new THREE.Mesh(stamp(place(paperGeometry(w, h))), paperMaterial);
  poster.receiveShadow = true;
  poster.name = 'billboard-poster';

  // The beams, one per lamp, from just under its glass up onto the poster. Not in the shadow or AO
  // passes (`markOccluder` is for solids), and not lights: see `drawWash` in city/billboardart.js
  // for where the light they throw is actually drawn.
  const beamGeo = lampAt.map((u) => stamp(beamGeometry(
    // Aimed at a point behind the paper, so the cone meets the poster about half way up and the
    // paper hides the rest: aimed over the top edge, the first cut stood its open end in the sky.
    toWorld(at, u, y0 + 0.5, 0.82), toWorld(at, u * 1.05, y0 + h * 0.6, -0.4), w / 8,
  )));
  const beams = new THREE.Mesh(mergeGeometries(beamGeo, false), unlitMaterial({
    vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
  }));
  beamGeo.forEach((g) => g.dispose());
  beams.renderOrder = 1;
  beams.name = 'billboard-beams';
  // A beam is light in the air, not a surface; the z-fight scan has nothing to compare it with.
  beams.userData.zfight = false;

  lamps.forEach(stamp);
  const glow = new THREE.Mesh(mergeGeometries(lamps, false), unlitMaterial({ vertexColors: true }));
  lamps.forEach((p) => p.dispose());
  glow.name = 'billboard-lamps';

  const group = new THREE.Group();
  group.name = 'billboard';
  group.add(shell, poster, glow, beams);
  return {
    site, group, shell, poster, glow, beams,
    /** Stamped meshes, for the entrance wave. Shell and poster are the solids (AO, sightline). */
    meshes: [shell, poster, glow, beams],
  };
}
