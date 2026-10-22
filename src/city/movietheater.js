import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { hash01, propMaterial, stampEntry, unlitMaterial } from '../util/geo.js';
import { color, jitterColor } from '../palette.js';
import { LOT_Y, PAINT_Y, box, span, wordParts } from './roadside.js';

// The movie theater: a tall fly tower with the name across its face, a low cream lobby in front of
// it, and a red marquee over the doors. Tyler asked for it at the workshop bench (2026-10-20), so it
// is a bench model for now — nothing in the city places it yet.
//
// **Which way it faces is settled by the camera.** Only +X and +Z faces are ever seen, so the
// entrance is on +Z and the tower's name goes on that same face, where the camera reads it.

const IN = 1.0;                  // off the block's −X, −Z and +X edges
const FRONT = 3.2;               // forecourt left open in front of the lobby, off the +Z edge
const LOBBY_D = 4.2;             // lobby depth along Z
const LOBBY_H = 3.4;
const TOWER_H = 8.5;
const MARQUEE = { out: 1.6, y: 2.5, h: 0.7 };
const DOOR_W = 2.2;
// Pixel size of "CINEMA" (29 pixels wide, 5 tall) and the framed board it sits on, 0.9 wider and
// 0.5 taller than the letters; BULB is the pitch of the bulbs round the frame.
const NAME_PIXEL = 0.27;
const SIGN = { w: 29 * NAME_PIXEL + 0.9, h: 5 * NAME_PIXEL + 0.5, rim: 0.2, out: 0.3 };
const BULB = 0.45;
const CHASE_PHASES = 3;          // every third bulb shares a phase; one phase is dark at a time
const CHASE_STEP = 0.14;         // seconds the dark gap spends on each phase

export const LANDMARK = {
  id: 'cinema', label: 'Movie theater', create: createMovieTheater, glow: (g) => [g.glow, ...g.bulbs].map((mesh) => [mesh, 'window']),
};

export function createMovieTheater(block, rng) {
  const { x0, x1, z0, z1, cx, cz } = block.bounds;
  const bx0 = x0 + IN;
  const bx1 = x1 - IN;
  const bz0 = z0 + IN;
  const lz1 = z1 - FRONT;                 // the tower's front face
  const lz0 = lz1 - LOBBY_D;
  const mid = (bx0 + bx1) / 2;
  const base = LOT_Y;
  const wall = jitterColor(color('cinemaWall'), rng, { l: 0.02 });
  const lobby = color('cinemaLobby');
  const trim = color('cinemaTrim');
  const red = color('cinemaMarquee');
  const gold = color('cinemaGold');

  const parts = [
    // The forecourt.
    span(x0 + 0.3, x1 - 0.3, LOT_Y - 0.04, LOT_Y, z0 + 0.3, z1 - 0.3, color('gasLot')),
    // The tower, with a coping, and the lobby in front of it.
    span(bx0, bx1, base, base + TOWER_H, bz0, lz1, wall),
    span(bx0 - 0.1, bx1 + 0.1, base + TOWER_H, base + TOWER_H + 0.3, bz0 - 0.1, lz1 + 0.1, trim),
    // Wider than the tower by 0.05 a side: flush, its side faces sat on the tower's own and fought.
    span(bx0 - 0.05, bx1 + 0.05, base, base + LOBBY_H, lz0, lz1 + 0.8, lobby),
    span(bx0 - 0.1, bx1 + 0.1, base + LOBBY_H, base + LOBBY_H + 0.25, lz0 - 0.1, lz1 + 0.9, trim),
    // A plant room on the tower roof.
    box(2.0, 1.0, 1.6, bx0 + 2.2, base + TOWER_H + 0.3, bz0 + 2.0, color('cinemaRoofUnit')),
  ];

  // --- The marquee: a plain red slab over the doors, and a post at each end -------------
  const fz = lz1 + 0.8;                   // the lobby's front face
  const mw = DOOR_W + 3.4;
  const my = base + MARQUEE.y;
  parts.push(
    span(mid - mw / 2, mid + mw / 2, my, my + MARQUEE.h, fz, fz + MARQUEE.out, red),
  );
  for (const s of [-1, 1]) {
    parts.push(box(0.16, MARQUEE.y, 0.16, mid + s * (mw / 2 - 0.15), base, fz + MARQUEE.out - 0.2, trim));
  }
  // The doors, dark under the marquee.
  parts.push(span(mid - DOOR_W / 2, mid + DOOR_W / 2, base, base + 2.2, fz, fz + 0.04, trim));

  // --- The name, on a dark band across the tower face above the lobby --------------------------
  const nameY = base + LOBBY_H + 2.6;
  parts.push(
    // The board proud of the wall, a gold frame round it, the bulbs (glow, below) on the frame.
    span(mid - SIGN.w / 2, mid + SIGN.w / 2, nameY - SIGN.h / 2, nameY + SIGN.h / 2, lz1, lz1 + SIGN.out, red),
    span(mid - SIGN.w / 2 - SIGN.rim, mid + SIGN.w / 2 + SIGN.rim, nameY + SIGN.h / 2,
      nameY + SIGN.h / 2 + SIGN.rim, lz1, lz1 + SIGN.out + 0.1, gold),
    span(mid - SIGN.w / 2 - SIGN.rim, mid + SIGN.w / 2 + SIGN.rim, nameY - SIGN.h / 2 - SIGN.rim,
      nameY - SIGN.h / 2, lz1, lz1 + SIGN.out + 0.1, gold),
    span(mid - SIGN.w / 2 - SIGN.rim, mid - SIGN.w / 2, nameY - SIGN.h / 2, nameY + SIGN.h / 2,
      lz1, lz1 + SIGN.out + 0.1, gold),
    span(mid + SIGN.w / 2, mid + SIGN.w / 2 + SIGN.rim, nameY - SIGN.h / 2, nameY + SIGN.h / 2,
      lz1, lz1 + SIGN.out + 0.1, gold),
  );

  // --- Poster frames either side of the doors --------------------------------------------------
  const posters = ['cinemaPosterA', 'cinemaPosterB', 'cinemaPosterC'].map((n) => color(n));
  const posterX = [-1, 1].flatMap((s) => [0, 1].map((n) => mid + s * (DOOR_W / 2 + 0.7 + n * 1.1)));
  posterX.forEach((x, n) => {
    parts.push(span(x - 0.4, x + 0.4, base + 0.5, base + 2.0, fz, fz + 0.04, trim));
    parts.push(span(x - 0.34, x + 0.34, base + 0.58, base + 1.92, fz + 0.04, fz + 0.06, posters[n % 3]));
  });
  // The red carpet, from the doors out across the forecourt to the kerb.
  parts.push(span(mid - DOOR_W / 2, mid + DOOR_W / 2, LOT_Y, PAINT_Y, fz + 0.04, z1 - 0.3, color('cinemaCarpet')));
  // And a ticket booth out in the forecourt.
  parts.push(box(1.0, 1.5, 0.9, bx1 - 1.0, base, fz + 1.4, red));
  parts.push(box(1.1, 0.12, 1.0, bx1 - 1.0, base + 1.5, fz + 1.4, gold));

  const anchorX = cx;
  const anchorZ = cz;
  const rand = hash01(anchorX, anchorZ);
  const stampAll = (geo) => stampEntry(geo, anchorX, anchorZ, rand);
  parts.forEach(stampAll);
  const shell = new THREE.Mesh(mergeGeometries(parts, false), propMaterial());
  parts.forEach((p) => p.dispose());
  shell.castShadow = true;
  shell.receiveShadow = true;
  shell.name = 'movie-theater';

  // --- What is lit: the lobby windows, the marquee face, and the name ---------------------------
  const glowCol = color('cinemaGlow');
  const glowParts = [
    span(bx0 + 0.4, mid - DOOR_W / 2 - 2.5, base + 0.6, base + 2.2, fz, fz + 0.03, glowCol),
    span(mid + DOOR_W / 2 + 2.5, bx1 - 0.4, base + 0.6, base + 2.2, fz, fz + 0.03, glowCol),
    span(bx1 + 0.05, bx1 + 0.08, base + 0.6, base + 2.2, lz0 + 0.6, lz1 - 0.6, glowCol),
  ];
  const name = wordParts('CINEMA', 0.14, glowCol, NAME_PIXEL);
  name.forEach((g) => g.translate(mid, nameY, lz1 + SIGN.out));
  glowParts.push(...name);
  glowParts.forEach(stampAll);
  const glow = new THREE.Mesh(mergeGeometries(glowParts, false), unlitMaterial({ vertexColors: true }));
  glowParts.forEach((p) => p.dispose());
  glow.name = 'movie-theater-glow';

  // --- The chase: bulbs round the sign's frame ----------------------------------------------------
  // Every third bulb belongs to one of CHASE_PHASES meshes, and the one whose turn it is goes dark,
  // so a dark gap runs round the loop the way a real marquee's does. Meshes taking turns being
  // visible rather than a colour per bulb: the glow is unlit vertex colour, and a mesh is cheap.
  const path = (corners, pitch) => corners.flatMap(([ax, ay], i) => {
    const [bx, by] = corners[(i + 1) % corners.length];
    const n = Math.max(1, Math.round(Math.hypot(bx - ax, by - ay) / pitch));
    return Array.from({ length: n }, (_, k) => [ax + ((bx - ax) * k) / n, ay + ((by - ay) * k) / n]);
  });
  const hw = SIGN.w / 2 + SIGN.rim / 2;
  const hh = SIGN.h / 2 + SIGN.rim / 2;
  const signRing = path([[-hw, hh], [hw, hh], [hw, -hh], [-hw, -hh]], BULB)
    .map(([x, y]) => box(0.16, 0.16, 0.08, mid + x, nameY + y - 0.08, lz1 + SIGN.out + 0.14, glowCol));
  const bulbs = Array.from({ length: CHASE_PHASES }, (_, phase) => {
    const set = signRing.filter((_, i) => i % CHASE_PHASES === phase);
    set.forEach(stampAll);
    const mesh = new THREE.Mesh(mergeGeometries(set, false), unlitMaterial({ vertexColors: true }));
    set.forEach((p) => p.dispose());
    mesh.name = `movie-theater-bulbs-${phase}`;
    return mesh;
  });

  const group = new THREE.Group();
  group.name = 'movie-theater-root';
  group.add(shell, glow, ...bulbs);

  let clock = 0;
  const update = (dt) => {
    clock += dt;
    const dark = Math.floor(clock / CHASE_STEP) % CHASE_PHASES;
    bulbs.forEach((mesh, phase) => { mesh.visible = phase !== dark; });
  };
  update(0);

  return {
    group,
    shell,
    glow,
    bulbs,
    update,
    meshes: [shell, glow, ...bulbs],
    entryObjects: [],
    entry: { x: anchorX, z: anchorZ, rand },
    entrySite: { x: anchorX, z: anchorZ, r: Math.max(x1 - x0, z1 - z0) / 2, rand },
  };
}
