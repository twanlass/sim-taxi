import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { bakeColor, propMaterial } from '../util/geo.js';
import { color } from '../palette.js';
import { makeRng } from '../util/rng.js';
import { WHEEL_R, ARCH_R, CHASSIS_LIFT, SILL_Y } from './wheels.js';
import { BODY_TOP, HOOD_HINGE_X, BOOT_HINGE_X, HOOD_LEN, BOOT_LEN } from './damage.js';
import { BUMPER_Y, BUMPER_H } from './bumpers.js';

// The taxi's paint, chipped down to the metal (the default; `?taxidamage=classic` for the old
// multiply toward `taxiGrime`). Tyler, 2026-10-21: the tint "is not reading" — a dulled yellow is
// still a yellow car, and with nothing beside it to compare against the eye takes it for the light.
//
// Each mark is a little patch of voxel cells laid over a panel: a core of bare silver ringed by dark
// primer. The ring is what carries it, and that is measured rather than taste: bare steel and taxi
// yellow are within a few points of each other in lightness, so a silver patch on its own reads at
// play zoom as a glint on the paint — the very "pale bonnet" low sun already puts there. The dark
// rim is a lightness step the eye cannot take for light. Sized for the camera: a cell is CELL × 1.18
// ≈ 0.11 world units, under a pixel at play zoom, so a cell is the voxel look up close and a mark
// is the read from far away — the first marks at a corner are 10-20 cells, ~4-6px across.
//
// The marks are grouped by the corner of the car they sit nearest, and each corner's are ranked
// from the corner inward: the hit lands, the struck corner's marks open up from its edge, and a
// glance says where the car was hit as well as how hard. See `setWear` and game/taxidamage.js.
//
// One merged geometry per host — the shell, the bonnet lid and the boot lid — with a mark hidden by
// collapsing its vertices onto one point. That is a CPU rewrite of a few thousand floats, but only
// on a frame the wear changes (a hit), and it keeps the whole thing to three draws with no shader
// patch: a patched material needs its own `customProgramCacheKey` and has bitten this file's
// neighbours often enough. Hidden by vertices rather than a scale for the reason the lids hide by
// scale: built at boot, so `markOccluder` and the ghost outline see the meshes the one time they walk.

const CAR_LEN = 3.4;
const CAR_W = 1.7;
const CELL = 0.09;
// How far a cell box stands off its panel. The deck and roof carry the chequer plates (to 0.024 up,
// see shellParts in geometry/taxi.js), so a mark there stands clear of those; elsewhere it only has
// to clear the paint. Each box also sinks SINK into the panel so it has no lip to see under.
const DECK_PROUD = 0.036;
const SIDE_PROUD = 0.014;
const SINK = 0.01;
// Marks per corner, before any cell is claimed by an earlier one.
const PER_CORNER = 10;
const ROOF_Y = 1.75 + CHASSIS_LIFT;

// The panels a mark can sit on, in car-local units: `axis` is the panel's normal, `at` the plane,
// (u, v) the two in-plane coordinates, `out` which way is off the panel. The deck runs are inside the
// lids' footprints (CAR_W * 0.94 wide), so a mark under a lid has a twin on the lid (see `lidOf`).
const ARCH_X = CAR_LEN * 0.3;
const ARCH_CLEAR = ARCH_R + 0.1;
const PANELS = [
  { name: 'hood', axis: 'y', at: BODY_TOP, out: 1, u: [HOOD_HINGE_X + 0.1, CAR_LEN / 2 - 0.1], v: [-0.72, 0.72], area: 1 },
  { name: 'boot', axis: 'y', at: BODY_TOP, out: 1, u: [BOOT_HINGE_X - BOOT_LEN + 0.1, BOOT_HINGE_X - 0.08], v: [-0.72, 0.72], area: 0.6 },
  // The roof's flat top runs −1.08 back to 0.23 (its front edge leans with the screen).
  { name: 'roof', axis: 'y', at: ROOF_Y, out: 1, u: [-1.0, 0.15], v: [-0.66, 0.66], area: 1.2 },
  // The flanks, between the arches and above them where there is room.
  ...[1, -1].map((side) => ({
    name: 'flank', axis: 'z', at: side * CAR_W / 2, out: side, u: [-0.75, 0.75], v: [SILL_Y + 0.12, BODY_TOP - 0.1], area: 0.7,
    keep: (x, y) => Math.hypot(Math.abs(x) - ARCH_X, y - WHEEL_R) > ARCH_CLEAR,
  })),
  // Nose and tail, above the bumper and inboard of the lamps.
  ...[1, -1].map((end) => ({
    name: 'end', axis: 'x', at: end * CAR_LEN / 2, out: end, u: [-0.45, 0.45], v: [BUMPER_Y + BUMPER_H / 2 + 0.08, BODY_TOP - 0.1], area: 0.35,
  })),
];

/** Car-local position of panel coordinates (u, v), `lift` off the panel. */
function place(panel, u, v, lift, target) {
  const n = panel.at + panel.out * lift;
  if (panel.axis === 'y') return target.set(u, n, v);
  if (panel.axis === 'z') return target.set(u, v, n);
  return target.set(n, v, u);
}

/** Which corner a car-local point belongs to — `${end},${side}`, the key game/taxidamage.js uses. */
const cornerOf = (x, z) => `${x >= 0 ? 1 : -1},${z >= 0 ? 1 : -1}`;

/**
 * Every mark on the car, decided once off a fixed seed: the same car wears the same chips every run,
 * which is what a real car's paint would do and makes the stills comparable. Answers the marks in
 * reveal order per corner, each with its cells split into core and rim.
 */
function layOut() {
  const rng = makeRng(0x5c7a7c);
  const candidates = [];
  const totalArea = PANELS.reduce((s, p) => s + p.area, 0);
  // Several times more candidates than will survive: the flanks reject most of theirs to the arches,
  // and a mark that lands on cells already claimed comes out empty.
  for (const panel of PANELS) {
    const n = Math.round((PER_CORNER * 4 * 4 * panel.area) / totalArea);
    for (let k = 0; k < n; k++) {
      const u = rng.range(panel.u[0], panel.u[1]);
      const v = rng.range(panel.v[0], panel.v[1]);
      const p = place(panel, u, v, 0, new THREE.Vector3());
      if (panel.keep && !panel.keep(p.x, p.y)) continue;
      const corner = cornerOf(p.x, p.z);
      const [end, side] = corner.split(',').map(Number);
      // Nearest the struck corner first, loosely: distance to the corner in the plan, plus jitter so
      // the order is not a clean wavefront.
      const d = Math.hypot(p.x - end * CAR_LEN / 2, p.z - side * CAR_W / 2) / CAR_LEN;
      candidates.push({ panel, u, v, corner, score: d + rng.range(0, 0.35), scratch: rng.chance(0.35) });
    }
  }
  const byCorner = new Map();
  for (const c of candidates) {
    if (!byCorner.has(c.corner)) byCorner.set(c.corner, []);
    byCorner.get(c.corner).push(c);
  }
  // Cells are claimed per panel, so two marks never put a box on the same spot (two coplanar boxes
  // would shimmer — CLAUDE.md on coplanar surfaces).
  const claimed = new Map(PANELS.map((p) => [p, new Set()]));
  const marks = [];
  for (const [corner, list] of byCorner) {
    list.sort((a, b) => a.score - b.score);
    let rank = 0;
    for (const c of list) {
      if (rank >= PER_CORNER) break;
      const { panel } = c;
      const taken = claimed.get(panel);
      // Bigger first: the marks a single hit opens are the ones that have to read from far away.
      const big = 1 - rank / PER_CORNER;
      const cu = Math.round(c.u / CELL);
      const cv = Math.round(c.v / CELL);
      const core = new Set();
      const fits = (i, j) => {
        const u = i * CELL;
        const v = j * CELL;
        if (u < panel.u[0] || u > panel.u[1] || v < panel.v[0] || v > panel.v[1]) return false;
        if (panel.keep) {
          const p = place(panel, u, v, 0, new THREE.Vector3());
          if (!panel.keep(p.x, p.y)) return false;
        }
        return !taken.has(`${i},${j}`);
      };
      if (c.scratch) {
        // A gouge: a run along the panel's length, a cell wide, stepping sideways now and then.
        const len = 4 + Math.round(big * 6 + rng.range(0, 2));
        const dir = rng.chance(0.5) ? 1 : -1;
        let i = cu;
        let j = cv;
        for (let s = 0; s < len; s++) {
          if (fits(i, j)) core.add(`${i},${j}`);
          i += dir;
          if (rng.chance(0.3)) j += rng.chance(0.5) ? 1 : -1;
        }
      } else {
        // A chip: grown cell by cell off its own edge, so it comes out ragged rather than round.
        const size = 3 + Math.round(big * 12 + rng.range(0, 3));
        if (fits(cu, cv)) core.add(`${cu},${cv}`);
        for (let tries = 0; core.size && core.size < size && tries < size * 8; tries++) {
          const from = [...core][rng.int(0, core.size - 1)].split(',').map(Number);
          const [di, dj] = rng.pick([[1, 0], [-1, 0], [0, 1], [0, -1]]);
          const i = from[0] + di;
          const j = from[1] + dj;
          if (fits(i, j)) core.add(`${i},${j}`);
        }
      }
      if (!core.size) continue;
      for (const key of core) taken.add(key);
      // The primer: every free cell sharing an edge with the core. Edges only — taking the diagonals
      // too closed the ring but doubled its share of the mark, and a field of them read as black
      // lettering on the bonnet rather than as chips.
      const rim = new Set();
      for (const key of core) {
        const [i, j] = key.split(',').map(Number);
        for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const k = `${i + di},${j + dj}`;
          if (!core.has(k) && !rim.has(k) && fits(i + di, j + dj)) rim.add(k);
        }
      }
      for (const key of rim) taken.add(key);
      marks.push({ panel, corner, rank: rank / PER_CORNER, core: [...core], rim: [...rim] });
      rank += 1;
    }
  }
  return marks;
}

/** The deck marks under a lid ride the lid too; this is the lid they belong to, if any. */
const lidOf = (mark) => (mark.panel.name === 'hood' || mark.panel.name === 'boot' ? mark.panel.name : null);

/**
 * Build the marks onto the taxi: one mesh on `group` for the shell, and one each on the two lid
 * hinges for the marks that sit under a lid. See the top of this file.
 */
export function buildScratches(group, hoodHinge, bootHinge) {
  const marks = layOut();
  const metal = color('taxiBareMetal');
  const primer = color('taxiPrimer');
  const at = new THREE.Vector3();

  // A host is one merged mesh: its marks, each with the vertex range it occupies.
  function host(parent, list, toLocal) {
    const parts = [];
    const ranges = [];
    let start = 0;
    for (const mark of list) {
      const { panel } = mark;
      const proud = panel.axis === 'y' ? DECK_PROUD : SIDE_PROUD;
      const thick = proud + SINK;
      for (const [cells, tint] of [[mark.core, metal], [mark.rim, primer]]) {
        for (const key of cells) {
          const [i, j] = key.split(',').map(Number);
          const box = panel.axis === 'y' ? new THREE.BoxGeometry(CELL, thick, CELL)
            : panel.axis === 'z' ? new THREE.BoxGeometry(CELL, CELL, thick)
              : new THREE.BoxGeometry(thick, CELL, CELL);
          place(panel, i * CELL, j * CELL, (proud - SINK) / 2, at);
          toLocal(at);
          box.translate(at.x, at.y, at.z);
          parts.push(bakeColor(box, tint));
        }
      }
      const end = parts.reduce((n, g) => n + g.attributes.position.count, 0);
      ranges.push({ mark, start, end });
      start = end;
    }
    const geometry = mergeGeometries(parts, false);
    parts.forEach((p) => p.dispose());
    geometry.computeBoundingSphere();
    const mesh = new THREE.Mesh(geometry, propMaterial());
    mesh.receiveShadow = true;
    mesh.userData.pickable = 'taxi';
    mesh.name = 'taxiScratches';
    parent.add(mesh);
    const position = geometry.attributes.position;
    return { mesh, ranges, rest: position.array.slice(), shown: ranges.map(() => true) };
  }

  const shell = host(group, marks, () => {});
  const hood = host(hoodHinge, marks.filter((m) => lidOf(m) === 'hood'),
    (p) => p.set(p.x - HOOD_HINGE_X, p.y - BODY_TOP + 0.06, p.z));
  const boot = host(bootHinge, marks.filter((m) => lidOf(m) === 'boot'),
    (p) => p.set(p.x - BOOT_HINGE_X, p.y - BODY_TOP + 0.06, p.z));
  const hosts = [shell, hood, boot];

  const levels = new Map();
  const lidUp = { hood: false, boot: false };

  /** Show or collapse each mark of `h` by `want(mark)`; touches the buffer only if something moved. */
  function apply(h, want) {
    const array = h.mesh.geometry.attributes.position.array;
    let dirty = false;
    h.ranges.forEach((r, k) => {
      const show = want(r.mark);
      if (show === h.shown[k]) return;
      h.shown[k] = show;
      dirty = true;
      if (show) {
        array.set(h.rest.subarray(r.start * 3, r.end * 3), r.start * 3);
      } else {
        // Every vertex onto the first: zero-area triangles, which the rasteriser draws nothing of.
        for (let n = r.start; n < r.end; n++) {
          array[n * 3] = h.rest[r.start * 3];
          array[n * 3 + 1] = h.rest[r.start * 3 + 1];
          array[n * 3 + 2] = h.rest[r.start * 3 + 2];
        }
      }
    });
    if (dirty) h.mesh.geometry.attributes.position.needsUpdate = true;
  }

  const worn = (mark) => mark.rank < (levels.get(mark.corner) ?? 0);
  function refresh() {
    // A deck mark on the shell hides while its lid is up: the lid carries it, and the bay under the
    // lid would otherwise wear a chip floating over its dark plate.
    apply(shell, (m) => worn(m) && !(lidOf(m) && lidUp[lidOf(m)]));
    apply(hood, worn);
    apply(boot, worn);
  }
  refresh();

  return {
    meshes: hosts.map((h) => h.mesh),
    /** Wear by corner, `${end},${side}` → 0..1 of that corner's marks showing. */
    setWear(next) {
      levels.clear();
      for (const [k, v] of next) levels.set(k, v);
      refresh();
    },
    /** Whether the bonnet ('hood') or boot lid is shown, so its marks ride it instead of the deck. */
    setLid(name, up) {
      if (lidUp[name] === up) return;
      lidUp[name] = up;
      refresh();
    },
    /** For the headless check: the marks drawn on host `k` — 0 the shell, 1 the bonnet, 2 the boot. */
    shownMarks(k = 0) {
      return hosts[k].ranges.filter((r, n) => hosts[k].shown[n]).map((r) => r.mark);
    },
    /** For the headless check: how many marks are showing, on the shell or a lid, by corner. */
    shownByCorner() {
      const out = new Map();
      const seen = new Set(hosts.flatMap((h, k) => (k === 0 || lidUp[k === 1 ? 'hood' : 'boot']
        ? this.shownMarks(k) : [])));
      for (const mark of seen) out.set(mark.corner, (out.get(mark.corner) ?? 0) + 1);
      return out;
    },
    marks,
  };
}
