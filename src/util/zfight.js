/**
 * Finds z-fighting in built geometry before anyone sees it on a phone.
 *
 * Z-fighting is two front-facing surfaces on the same plane covering the same ground, and that is a
 * fact about the *triangles*, not about any one frame — so this reads them rather than rendering
 * them. Every case this project has shipped was an exact tie (the channel wall under the embankment
 * kerb, the abutment on the channel wall, the drive-through apron on the pavement), and an exact tie
 * is precisely what a render cannot be trusted to show: it resolves the same way on every frame of a
 * headless still and differently on a phone's rasteriser. The arithmetic is the same everywhere.
 *
 * The scan, per call:
 *   1. every triangle of every visible mesh under `root`, in world space (each instance of an
 *      `InstancedMesh` separately), minus the ones nothing can draw — a back face under a one-sided
 *      material, when the view direction is known;
 *   2. bucketed by plane — normal to a fraction of a degree, offset to `tolerance`;
 *   3. within a bucket, every pair whose projected outlines share more than `minArea` of ground.
 *
 * What it deliberately lets through, so that a finding is something to fix rather than to argue
 * with:
 *   - a material with `polygonOffset` on: that is the declared way to lay a decal on a surface;
 *   - `depthTest: false`: it never compares depth with anything;
 *   - two triangles that would draw the **same colour** (same material colour, same baked vertex
 *     colour, no texture): they tie, and a tie between identical pixels is invisible. This is what
 *     keeps a merged mesh's own seams — a box face laid edge to edge with a neighbour, a duplicate
 *     face from a merge — out of the report;
 *   - anything under an object with `userData.zfight === false`: an opt-out, for a case with a
 *     reason (write the reason beside it).
 *
 * The tolerance is a real number and not a fudge. The game's camera is orthographic, so its depth
 * buffer is linear: 1400 units over 24 bits is 8e-5 a step, 0.021 over the 16 bits a phone may hand
 * back. The default of 0.004 catches every exact tie and float-noise near-tie while leaving the
 * house idiom — one surface laid 0.01 over another (`PAVEMENT_Y`, `APRON_Y`, `PAINT_Y`) — alone.
 *
 *   findZFighting(object3D, { view: VIEW_DIR })  →  [{ a, b, area, at, normal, triangles }]
 *
 * Pure three.js, no DOM: `tools/zfight.mjs` runs it over the city and the workshop's bench in
 * `npm run check`, and `__taxi.zfight()` / the workshop's viewer run it in a page.
 */
import * as THREE from 'three';

export const ZFIGHT_TOLERANCE = 0.002;
// Overlaps smaller than this are a sliver where two triangles meet at a shallow angle, not a patch.
// At play zoom one unit is ~7.7px, so 0.03 square units is about two pixels.
export const ZFIGHT_MIN_AREA = 0.03;
// Normals closer than this (cosine) count as the same plane: about half a degree.
const SAME_NORMAL = Math.cos(THREE.MathUtils.degToRad(0.5));
const NORMAL_BINS = 360;

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _n = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _col = new THREE.Color();

/** A short, stable name for a mesh in a report: its own name, else its ancestors', else its type. */
export function meshLabel(mesh) {
  const names = [];
  for (let o = mesh; o; o = o.parent) if (o.name) names.push(o.name);
  if (names.length) return names.reverse().join('/');
  const g = mesh.geometry;
  return `${mesh.type}(${g?.type ?? '?'}, ${g ? triangleCount(g) : 0} tris)`;
}

function triangleCount(g) {
  return Math.floor((g.index ? g.index.count : g.attributes.position.count) / 3);
}

function skipped(object) {
  for (let o = object; o; o = o.parent) {
    if (o.visible === false || o.userData?.zfight === false) return true;
  }
  return false;
}

/** Every material a mesh draws a triangle with, indexed per triangle through its groups. */
function materialAt(mesh, groups, t) {
  if (!Array.isArray(mesh.material)) return mesh.material;
  for (const g of groups) {
    if (t * 3 >= g.start && t * 3 < g.start + g.count) return mesh.material[g.materialIndex];
  }
  return null;
}

function drawsDepth(material) {
  return material && material.visible !== false && material.depthTest !== false && !material.polygonOffset
    && material.colorWrite !== false;
}

/**
 * How far a face turns toward the camera. With `spin`, the object can face any way round the
 * vertical (a car drives all four ways), so this is the best the face can do over every heading.
 */
function towardCamera(n, view, spin) {
  if (!spin) return n.dot(view);
  return n.y * view.y + Math.hypot(n.x, n.z) * Math.hypot(view.x, view.z);
}

/**
 * Collect world-space triangles. Each comes back as a flat record so the buckets below can hold a
 * million of them without a million Vector3s.
 */
function collect(root, view, spin) {
  const tris = [];
  const meshes = [];
  root.updateMatrixWorld(true);
  root.traverse((mesh) => {
    if (!mesh.isMesh || !mesh.geometry?.attributes?.position || skipped(mesh)) return;
    const g = mesh.geometry;
    const pos = g.attributes.position;
    const col = g.attributes.color;
    const index = g.index;
    const count = triangleCount(g);
    if (!count) return;
    const meshId = meshes.length;
    meshes.push(mesh);
    const instances = mesh.isInstancedMesh ? mesh.count : 1;
    for (let inst = 0; inst < instances; inst += 1) {
      if (mesh.isInstancedMesh) {
        mesh.getMatrixAt(inst, _m);
        _m.premultiply(mesh.matrixWorld);
      } else {
        _m.copy(mesh.matrixWorld);
      }
      // A mirrored transform reverses every triangle's winding, and so which side is the front.
      const flip = _m.determinant() < 0 ? -1 : 1;
      for (let t = 0; t < count; t += 1) {
        const material = materialAt(mesh, g.groups, t);
        if (!drawsDepth(material)) continue;
        const i0 = index ? index.getX(t * 3) : t * 3;
        const i1 = index ? index.getX(t * 3 + 1) : t * 3 + 1;
        const i2 = index ? index.getX(t * 3 + 2) : t * 3 + 2;
        _a.fromBufferAttribute(pos, i0).applyMatrix4(_m);
        _b.fromBufferAttribute(pos, i1).applyMatrix4(_m);
        _c.fromBufferAttribute(pos, i2).applyMatrix4(_m);
        _n.subVectors(_b, _a).cross(_c.clone().sub(_a)).multiplyScalar(flip);
        const twice = _n.length();
        if (twice < 1e-9) continue;
        _n.divideScalar(twice);
        const side = material.side ?? THREE.FrontSide;
        // Under a one-sided material only one face of the plane can draw; when the camera's direction
        // is fixed, a front face turned away from it never draws at all.
        if (view && side !== THREE.DoubleSide) {
          const facing = (side === THREE.BackSide ? -1 : 1) * towardCamera(_n, view, spin);
          if (facing <= 1e-6) continue;
        }
        // What colour the triangle would come out, for the identical-pixels exemption.
        let shade = null;
        if (!material.map && material.color) {
          _col.copy(material.color);
          if (col && material.vertexColors) {
            const r = (col.getX(i0) + col.getX(i1) + col.getX(i2)) / 3;
            const gg = (col.getY(i0) + col.getY(i1) + col.getY(i2)) / 3;
            const b = (col.getZ(i0) + col.getZ(i1) + col.getZ(i2)) / 3;
            _col.r *= r; _col.g *= gg; _col.b *= b;
          }
          shade = `${material.type}:${Math.round(_col.r * 255)},${Math.round(_col.g * 255)},${Math.round(_col.b * 255)}`;
        }
        tris.push({
          mesh: meshId,
          two: side === THREE.DoubleSide,
          nx: _n.x, ny: _n.y, nz: _n.z,
          d: _n.dot(_a),
          p: [_a.x, _a.y, _a.z, _b.x, _b.y, _b.z, _c.x, _c.y, _c.z],
          shade,
        });
      }
    }
  });
  return { tris, meshes };
}

/**
 * The normal folded onto one hemisphere, so a double-sided triangle facing the other way lands in
 * the same bucket. The sign is carried separately.
 */
function canonical(t) {
  const s = (t.nx < -1e-9 || (Math.abs(t.nx) <= 1e-9 && (t.ny < -1e-9 || (Math.abs(t.ny) <= 1e-9 && t.nz < 0)))) ? -1 : 1;
  return s;
}

// Projected onto the plane by dropping its dominant axis; areas come back scaled by 1/|n_dominant|.
function project(t) {
  const ax = Math.abs(t.nx); const ay = Math.abs(t.ny); const az = Math.abs(t.nz);
  const p = t.p;
  if (ax >= ay && ax >= az) return { pts: [[p[1], p[2]], [p[4], p[5]], [p[7], p[8]]], scale: 1 / ax };
  if (ay >= az) return { pts: [[p[0], p[2]], [p[3], p[5]], [p[6], p[8]]], scale: 1 / ay };
  return { pts: [[p[0], p[1]], [p[3], p[4]], [p[6], p[7]]], scale: 1 / az };
}

function signedArea(poly) {
  let s = 0;
  for (let i = 0; i < poly.length; i += 1) {
    const [x0, y0] = poly[i];
    const [x1, y1] = poly[(i + 1) % poly.length];
    s += x0 * y1 - x1 * y0;
  }
  return s / 2;
}

/** Sutherland–Hodgman: the overlap of two convex polygons, both wound counter-clockwise. */
function clip(subject, clipper) {
  let out = subject;
  for (let i = 0; i < clipper.length && out.length; i += 1) {
    const [ax, ay] = clipper[i];
    const [bx, by] = clipper[(i + 1) % clipper.length];
    const inside = ([x, y]) => (bx - ax) * (y - ay) - (by - ay) * (x - ax) >= -1e-12;
    const input = out;
    out = [];
    for (let j = 0; j < input.length; j += 1) {
      const p = input[j];
      const q = input[(j + 1) % input.length];
      const pin = inside(p);
      const qin = inside(q);
      if (pin) out.push(p);
      if (pin !== qin) {
        const dx = q[0] - p[0]; const dy = q[1] - p[1];
        const den = (bx - ax) * dy - (by - ay) * dx;
        if (Math.abs(den) > 1e-15) {
          const s = ((by - ay) * (p[0] - ax) - (bx - ax) * (p[1] - ay)) / den;
          out.push([p[0] + s * dx, p[1] + s * dy]);
        }
      }
    }
  }
  return out;
}

function ccw(pts) {
  return signedArea(pts) < 0 ? [pts[0], pts[2], pts[1]] : pts;
}

/** The shared patch of two coplanar triangles: its true area, and a few points on it in 3D. */
function overlap(t, u) {
  const P = project(t);
  const Q = project(u);
  const poly = clip(ccw(P.pts), ccw(Q.pts));
  if (poly.length < 3) return { area: 0, points: [] };
  const area = Math.abs(signedArea(poly)) * P.scale;
  // Lifted back onto t's plane through the axis `project` dropped. The centre, and each corner
  // drawn a fifth of the way in so a sample is never on an edge a neighbour shares.
  const ax = Math.abs(t.nx); const ay = Math.abs(t.ny); const az = Math.abs(t.nz);
  const lift = ([p, q]) => {
    if (ax >= ay && ax >= az) return [(t.d - t.ny * p - t.nz * q) / t.nx, p, q];
    if (ay >= az) return [p, (t.d - t.nx * p - t.nz * q) / t.ny, q];
    return [p, q, (t.d - t.nx * p - t.ny * q) / t.nz];
  };
  const cx = poly.reduce((acc, q) => acc + q[0], 0) / poly.length;
  const cy = poly.reduce((acc, q) => acc + q[1], 0) / poly.length;
  const points = [lift([cx, cy]), ...poly.map(([x, y]) => lift([x + (cx - x) * 0.2, y + (cy - y) * 0.2]))];
  return { area, points };
}

/**
 * Whether a point on a surface is covered: a short ray from just off the surface, toward the camera
 * (or straight out along the normal when there is no one camera), that strikes anything at all.
 *
 * This is what keeps a tie *inside* a solid out of the report. A wing's top face is buried under its
 * own cornice, and so is the corner of the neighbouring wing's deck that runs in over it; both are
 * on one plane, both are real triangles, and neither can ever reach the screen. The ray is short on
 * purpose (`OCCLUDE_REACH`): the question is "is this buried", not "is there a tower between it and
 * the camera" — a tie behind a tower is still a tie, and the camera moves.
 */
const OCCLUDE_REACH = 2;
const GRID = 2;
const BIG_CELLS = 4096;
function occluderGrid(tris) {
  const big = [];
  const grid = new Map([['big', big]]);
  for (let k = 0; k < tris.length; k += 1) {
    const p = tris[k].p;
    const lo = [0, 1, 2].map((a) => Math.floor(Math.min(p[a], p[a + 3], p[a + 6]) / GRID));
    const hi = [0, 1, 2].map((a) => Math.floor(Math.max(p[a], p[a + 3], p[a + 6]) / GRID));
    // The sky dome and the sea are a few triangles hundreds of units across; filed cell by cell
    // they overflowed a Map in the live scene. They go on one list every lookup reads.
    if ((hi[0] - lo[0] + 1) * (hi[1] - lo[1] + 1) * (hi[2] - lo[2] + 1) > BIG_CELLS) {
      big.push(k);
      continue;
    }
    for (let x = lo[0]; x <= hi[0]; x += 1) {
      for (let y = lo[1]; y <= hi[1]; y += 1) {
        for (let z = lo[2]; z <= hi[2]; z += 1) {
          const key = `${x},${y},${z}`;
          let list = grid.get(key);
          if (!list) grid.set(key, list = []);
          list.push(k);
        }
      }
    }
  }
  return grid;
}

// Möller–Trumbore, both faces: the distance along the ray, or Infinity.
function rayHit(o, d, p) {
  const e1x = p[3] - p[0]; const e1y = p[4] - p[1]; const e1z = p[5] - p[2];
  const e2x = p[6] - p[0]; const e2y = p[7] - p[1]; const e2z = p[8] - p[2];
  const hx = d[1] * e2z - d[2] * e2y; const hy = d[2] * e2x - d[0] * e2z; const hz = d[0] * e2y - d[1] * e2x;
  const det = e1x * hx + e1y * hy + e1z * hz;
  if (Math.abs(det) < 1e-12) return Infinity;
  const inv = 1 / det;
  const sx = o[0] - p[0]; const sy = o[1] - p[1]; const sz = o[2] - p[2];
  const u = (sx * hx + sy * hy + sz * hz) * inv;
  if (u < 0 || u > 1) return Infinity;
  const qx = sy * e1z - sz * e1y; const qy = sz * e1x - sx * e1z; const qz = sx * e1y - sy * e1x;
  const v = (d[0] * qx + d[1] * qy + d[2] * qz) * inv;
  if (v < 0 || u + v > 1) return Infinity;
  const t = (e2x * qx + e2y * qy + e2z * qz) * inv;
  return t > 0 ? t : Infinity;
}

function covered(point, normal, dir, lift, tris, grid) {
  const o = [0, 1, 2].map((a) => point[a] + normal[a] * lift);
  const end = [0, 1, 2].map((a) => o[a] + dir[a] * OCCLUDE_REACH);
  const lo = [0, 1, 2].map((a) => Math.floor(Math.min(o[a], end[a]) / GRID));
  const hi = [0, 1, 2].map((a) => Math.floor(Math.max(o[a], end[a]) / GRID));
  const tested = new Set();
  for (const k of grid.get('big')) {
    if (rayHit(o, dir, tris[k].p) <= OCCLUDE_REACH) return true;
  }
  for (let x = lo[0]; x <= hi[0]; x += 1) {
    for (let y = lo[1]; y <= hi[1]; y += 1) {
      for (let z = lo[2]; z <= hi[2]; z += 1) {
        for (const k of grid.get(`${x},${y},${z}`) ?? []) {
          if (tested.has(k)) continue;
          tested.add(k);
          if (rayHit(o, dir, tris[k].p) <= OCCLUDE_REACH) return true;
        }
      }
    }
  }
  return false;
}

/**
 * Coplanar overlapping surfaces under `root`, grouped by the pair of meshes they belong to and
 * sorted largest first. `view` is the unit vector from the scene toward the camera (`VIEW_DIR` in
 * the game), so a face the camera can never see is not reported; `spin` says the object itself
 * turns about the vertical (a vehicle), so a face counts if *any* heading shows it. Leave `view` out
 * to report every face regardless.
 */
export function findZFighting(root, {
  view = null, spin = false, tolerance = ZFIGHT_TOLERANCE, minArea = ZFIGHT_MIN_AREA,
} = {}) {
  const { tris, meshes } = collect(root, view, spin);

  // Bucket by (folded normal, offset). Neighbouring offset bins are both searched below, so a pair
  // straddling a bin edge is still compared.
  const buckets = new Map();
  for (let k = 0; k < tris.length; k += 1) {
    const t = tris[k];
    const s = canonical(t);
    t.s = s;
    const key = `${Math.round(t.nx * s * NORMAL_BINS)},${Math.round(t.ny * s * NORMAL_BINS)},${Math.round(t.nz * s * NORMAL_BINS)}`;
    t.key = key;
    t.bin = Math.floor((t.d * s) / tolerance);
    const id = `${key}|${t.bin}`;
    let list = buckets.get(id);
    if (!list) buckets.set(id, list = []);
    list.push(k);
  }

  const pairs = new Map();
  const grid = occluderGrid(tris);
  const compare = (i, j, plane) => {
    const t = tris[i]; const u = tris[j];
    // Same facing, or either one drawn from both sides.
    const dot = t.nx * u.nx + t.ny * u.ny + t.nz * u.nz;
    if (dot < SAME_NORMAL && !((t.two || u.two) && -dot >= SAME_NORMAL)) return;
    if (Math.abs(t.d * t.s - u.d * u.s) > tolerance) return;
    if (t.shade !== null && t.shade === u.shade) return;
    // Cheap reject on the world-space boxes before clipping.
    const pt = t.p; const pu = u.p;
    for (let ax = 0; ax < 3; ax += 1) {
      const tlo = Math.min(pt[ax], pt[ax + 3], pt[ax + 6]); const thi = Math.max(pt[ax], pt[ax + 3], pt[ax + 6]);
      const ulo = Math.min(pu[ax], pu[ax + 3], pu[ax + 6]); const uhi = Math.max(pu[ax], pu[ax + 3], pu[ax + 6]);
      if (tlo > uhi + tolerance || ulo > thi + tolerance) return;
    }
    const { area: whole, points } = overlap(t, u);
    if (whole <= 1e-6) return;
    // Only the share of the patch that is not buried counts.
    const normal = [t.nx, t.ny, t.nz];
    const dir = view && !spin ? [view.x, view.y, view.z] : normal;
    const open = points.filter((q) => !covered(q, normal, dir, tolerance * 4, tris, grid)).length;
    const area = (whole * open) / points.length;
    if (area <= 1e-6) return;
    const [ma, mb] = t.mesh <= u.mesh ? [t.mesh, u.mesh] : [u.mesh, t.mesh];
    // Kept per plane, not per pair of meshes: a merged mesh holds a thousand flower heads, and a
    // thousand specks of tie a few hundredths of a pixel each are not one visible fight.
    const id = `${ma}:${mb}|${plane}`;
    let rec = pairs.get(id);
    if (!rec) {
      pairs.set(id, rec = {
        a: meshes[ma], b: meshes[mb], area: 0, triangles: 0, biggest: 0, at: null, normal: null,
      });
    }
    rec.area += area;
    rec.triangles += 1;
    if (area > rec.biggest) {
      rec.biggest = area;
      rec.at = new THREE.Vector3((pt[0] + pt[3] + pt[6]) / 3, (pt[1] + pt[4] + pt[7]) / 3, (pt[2] + pt[5] + pt[8]) / 3);
      rec.normal = new THREE.Vector3(t.nx, t.ny, t.nz);
      rec.sample = [{ points: pt, shade: t.shade, offset: t.d }, { points: pu, shade: u.shade, offset: u.d }];
    }
  };

  for (const [id, list] of buckets) {
    const [key, binText] = id.split('|');
    const bin = Number(binText);
    const near = [list, buckets.get(`${key}|${bin + 1}`)].filter(Boolean);
    // A uniform 2D grid over the bucket keeps a plane holding thousands of triangles (the ground)
    // from becoming a quadratic loop.
    const cell = 4;
    const grid = new Map();
    const cellsOf = (t) => {
      const { pts } = project(t);
      const xs = pts.map((q) => q[0]); const ys = pts.map((q) => q[1]);
      const out = [];
      const span = (Math.floor(Math.max(...xs) / cell) - Math.floor(Math.min(...xs) / cell) + 1)
        * (Math.floor(Math.max(...ys) / cell) - Math.floor(Math.min(...ys) / cell) + 1);
      if (span > BIG_CELLS) return ['big'];
      for (let x = Math.floor(Math.min(...xs) / cell); x <= Math.floor(Math.max(...xs) / cell); x += 1) {
        for (let y = Math.floor(Math.min(...ys) / cell); y <= Math.floor(Math.max(...ys) / cell); y += 1) {
          out.push(`${x},${y}`);
        }
      }
      return out;
    };
    const seen = new Set();
    for (const group of near) {
      for (const k of group) {
        for (const c of cellsOf(tris[k])) {
          let l = grid.get(c);
          if (!l) grid.set(c, l = []);
          l.push(k);
        }
      }
    }
    for (const l of grid.values()) {
      for (let x = 0; x < l.length; x += 1) {
        // Only pairs with at least one member from this bucket: the neighbour bin's own pairs are
        // compared when it is the bucket.
        for (let y = x + 1; y < l.length; y += 1) {
          const i = l[x]; const j = l[y];
          if (tris[i].bin !== bin && tris[j].bin !== bin) continue;
          if (i === j) continue;
          const pid = i < j ? i * tris.length + j : j * tris.length + i;
          if (seen.has(pid)) continue;
          seen.add(pid);
          compare(i, j, id);
        }
      }
    }
    // A plane-sized triangle filed under 'big' meets everything else on its plane.
    for (const i of grid.get('big') ?? []) {
      for (const group of near) {
        for (const j of group) {
          if (i === j || (tris[i].bin !== bin && tris[j].bin !== bin)) continue;
          const pid = i < j ? i * tris.length + j : j * tris.length + i;
          if (seen.has(pid)) continue;
          seen.add(pid);
          compare(i, j, id);
        }
      }
    }
  }

  // Then each plane's patch is judged on its own and the survivors gathered back by pair of meshes.
  const byMeshes = new Map();
  for (const [id, r] of pairs) {
    if (r.area < minArea) continue;
    const key = id.split('|')[0];
    const into = byMeshes.get(key);
    if (!into) { byMeshes.set(key, { ...r, planes: 1 }); continue; }
    into.area += r.area;
    into.triangles += r.triangles;
    into.planes += 1;
    if (r.biggest > into.biggest) Object.assign(into, { biggest: r.biggest, at: r.at, normal: r.normal, sample: r.sample });
  }
  return [...byMeshes.values()]
    .sort((x, y) => y.area - x.area)
    .map((r) => ({ ...r, aLabel: meshLabel(r.a), bLabel: meshLabel(r.b) }));
}

/** One line per finding, for a console or a check's detail. */
export function describeZFighting(found, limit = 8) {
  return found.slice(0, limit).map((f) => {
    const who = f.a === f.b ? `${f.aLabel} against itself` : `${f.aLabel} × ${f.bLabel}`;
    const at = f.at ? `(${f.at.x.toFixed(2)}, ${f.at.y.toFixed(2)}, ${f.at.z.toFixed(2)})` : '';
    const n = f.normal ? `facing (${f.normal.x.toFixed(2)}, ${f.normal.y.toFixed(2)}, ${f.normal.z.toFixed(2)})` : '';
    return `${who}: ${f.area.toFixed(2)} u² over ${f.triangles} pairs, e.g. at ${at} ${n}`;
  });
}
