import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { bakeColor, hash01, propMaterial, stampEntry, unlitMaterial } from '../util/geo.js';
import { color } from '../palette.js';
import { clearOf } from './vetclinic.js';

// The rooftop billboard: one flat roof per city carries a big steel-legged advertising hoarding,
// the kind that stands over a low warehouse beside an expressway. Tyler asked for "a fun little
// billboard on a roof top" on 2026-11-04.
//
// **What it says.** An ad for the other side: the robo-taxis the council approved, arriving on
// Monday (the story the intro tells). It is a teaser, so the one thing that has to read is the
// day — and at play zoom a world unit is ~7.7px, so a word the full width of a seven-unit board
// lands about ten pixels tall. That is enough for one word and no more, which is why the copy is
// one huge **MONDAY.** with a small "ROBO-TAXIS ARRIVE" over it that only reads when the player
// pinches in. The type is the same blocky pixel face as the car wash's sign (city/roadside.js),
// built as flat quads rather than boxes, and condensed — each pixel 1.4 times as tall as it is
// wide — because a billboard's lettering always is, and because it buys 40% more height for the
// one word that has to land.
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
const BORDER = 0.18;            // the steel frame showing round the poster
const POST = 0.16;              // the posts' section
const RAKE = 1.2;               // how far behind the board the raking braces land on the deck

/** Face normal and the board's own +X, in world space: square to the camera. */
const OUT = new THREE.Vector3(1, 0, 1).normalize();
const ALONG = new THREE.Vector3(1, 0, -1).normalize();

// --- The poster -------------------------------------------------------------------------------

// The pixel face, five rows, top to bottom. The car wash's letters (city/roadside.js) plus the ones
// the copy needs; kept here rather than shared because the strap line wants punctuation theirs
// does not have, and a sign's glyphs are a sign's.
const GLYPHS = {
  A: ['.XX.', 'X..X', 'XXXX', 'X..X', 'X..X'],
  B: ['XXX.', 'X..X', 'XXX.', 'X..X', 'XXX.'],
  D: ['XXX.', 'X..X', 'X..X', 'X..X', 'XXX.'],
  E: ['XXXX', 'X...', 'XXX.', 'X...', 'XXXX'],
  I: ['XXX', '.X.', '.X.', '.X.', 'XXX'],
  M: ['X...X', 'XX.XX', 'X.X.X', 'X...X', 'X...X'],
  N: ['X..X', 'XX.X', 'X.XX', 'X..X', 'X..X'],
  O: ['.XX.', 'X..X', 'X..X', 'X..X', '.XX.'],
  R: ['XXX.', 'X..X', 'XXX.', 'X.X.', 'X..X'],
  S: ['.XXX', 'X...', '.XX.', '...X', 'XXX.'],
  T: ['XXX', '.X.', '.X.', '.X.', '.X.'],
  V: ['X...X', 'X...X', 'X...X', '.X.X.', '..X..'],
  X: ['X...X', '.X.X.', '..X..', '.X.X.', 'X...X'],
  Y: ['X...X', '.X.X.', '..X..', '..X..', '..X..'],
  '-': ['...', '...', 'XXX', '...', '...'],
  '.': ['.', '.', '.', '.', 'X'],
  ' ': ['..', '..', '..', '..', '..'],
};

/** A line of text's width in pixel columns, one blank column between letters. */
function columns(text) {
  return [...text].reduce((n, ch) => n + GLYPHS[ch][0].length + 1, -1);
}

/**
 * A line of text as flat quads facing +Z at `z`, centred on (0, `cy`), pixels `pw` wide and `ph`
 * tall. Each row's run of lit pixels is one quad rather than one per pixel: the letters are flat
 * print on paper, so there are no seams between pixels to keep.
 */
function textParts(text, pw, ph, cy, z, col) {
  const parts = [];
  let cx = -(columns(text) * pw) / 2;
  for (const ch of text) {
    const rows = GLYPHS[ch];
    rows.forEach((row, ry) => {
      const y = cy + (2 - ry) * ph;
      for (let rx = 0; rx < row.length;) {
        if (row[rx] !== 'X') { rx += 1; continue; }
        let end = rx;
        while (row[end + 1] === 'X') end += 1;
        const geo = new THREE.PlaneGeometry((end - rx + 1) * pw, ph);
        geo.translate(cx + ((rx + end + 1) / 2) * pw, y, z);
        parts.push(bakeColor(geo, col));
        rx = end + 1;
      }
    });
    cx += (rows[0].length + 1) * pw;
  }
  return parts;
}

/** The headline and the strap line over it. */
export const COPY = { strap: 'ROBO-TAXIS ARRIVE', head: 'MONDAY.' };

/**
 * The poster, in the board's own frame: centred at the origin, facing +Z, the panel's front at
 * z = 0. Paper 0.01 proud of the panel, and the print 0.01 proud of the paper — three planes, never
 * two on one (see tools/zfight.mjs).
 */
export function posterParts(w, h, copy = COPY) {
  const fw = w - 2 * BORDER;
  const fh = h - 2 * BORDER;
  const paper = new THREE.PlaneGeometry(fw, fh);
  paper.translate(0, 0, 0.01);
  const parts = [bakeColor(paper, color('billboardPaper'))];

  const ink = color('billboardInk');
  const accent = color('billboardAccent');
  // The headline as wide as the paper allows less a margin, condensed 1.4 : 1.
  const pw = (fw * 0.88) / columns(copy.head);
  const ph = pw * 1.4;
  const headY = -fh * 0.08;
  parts.push(...textParts(copy.head, pw, ph, headY, 0.02, ink));
  // The strap line, small, over it. Only legible pinched in; at play zoom it is a teal rule.
  const sw = Math.min(pw * 0.42, (fw * 0.8) / columns(copy.strap));
  // Centred in the gap between the headline's top and the paper's.
  const strapY = (headY + 2.5 * ph + fh / 2) / 2;
  parts.push(...textParts(copy.strap, sw, sw * 1.2, strapY, 0.02, accent));
  // A teal bar along the foot of the poster: the brand's one stroke of colour, and what still says
  // "printed ad" rather than "sign" once the strap line is too small to see.
  const barH = fh * 0.07;
  const bar = new THREE.PlaneGeometry(fw * 0.88, barH);
  bar.translate(0, -fh / 2 + fh * 0.09, 0.02);
  parts.push(bakeColor(bar, accent));
  return parts;
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
 * Pick the city's billboard roof from the towers `createBuildings` built, or null.
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
  if (!candidates.length) return null;
  // The widest board wins; among equals (every full-block warehouse gives MAX_W) a hash picks.
  const best = Math.max(...candidates.map((c) => c.w));
  const pool = candidates.filter((c) => c.w > best - 0.01);
  const sx = pool.reduce((n, c) => n + c.tower.cx, 0);
  const sz = pool.reduce((n, c) => n + c.tower.cz, 0);
  const { tower, at, w, h, y0, half } = pool[Math.floor(hash01(sx * 0.53, sz * 0.29) * pool.length) % pool.length];
  // The birds roost on decks and walk round what stands on them (game/birds.js): the strip the
  // posts and braces occupy.
  const ends = [toWorld(at, -half, 0, 0.1), toWorld(at, half, 0, 0.1), toWorld(at, -half, 0, -RAKE),
    toWorld(at, half, 0, -RAKE)];
  tower.deck.keep.push({
    x0: Math.min(...ends.map((p) => p.x)), x1: Math.max(...ends.map((p) => p.x)),
    z0: Math.min(...ends.map((p) => p.z)), z1: Math.max(...ends.map((p) => p.z)),
  });
  return {
    at, w, h, y0, half, deck: tower.deck.deck,
    anchor: { x: tower.cx, z: tower.cz, rand: hash01(tower.cx, tower.cz) },
    // Where to point a camera: the middle of the face.
    focus: toWorld(at, 0, y0 + h / 2, 0),
  };
}

// --- Building it ------------------------------------------------------------------------------

/**
 * The billboard: the steel (posts, braces, the panel and its catwalk, lit), the poster (lit, its own
 * mesh because it receives shadow but does not cast — paper 0.01 off a panel that casts would
 * shadow itself, see `sinkShadowCaster` in game/scene.js), and the three lamps over it (unlit, a
 * light). All stamped for the entrance wave with the tower's own anchor so it rises with its roof.
 */
export function createBillboard(site, { copy = COPY } = {}) {
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

  const posterGeo = posterParts(w, h, copy).map((g) => stamp(place(g)));
  const poster = new THREE.Mesh(mergeGeometries(posterGeo, false), propMaterial());
  posterGeo.forEach((p) => p.dispose());
  poster.receiveShadow = true;
  poster.name = 'billboard-poster';

  lamps.forEach(stamp);
  const glow = new THREE.Mesh(mergeGeometries(lamps, false), unlitMaterial({ vertexColors: true }));
  lamps.forEach((p) => p.dispose());
  glow.name = 'billboard-lamps';

  const group = new THREE.Group();
  group.name = 'billboard';
  group.add(shell, poster, glow);
  return {
    site, group, shell, poster, glow,
    /** Stamped meshes, for the entrance wave, the AO prepass and the sightline field. */
    meshes: [shell, poster, glow],
  };
}
