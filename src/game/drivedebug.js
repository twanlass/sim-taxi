/**
 * The steering debug overlay for free driving: what the stick asked for, what the assists did to
 * it, and why (Tyler, 2026-11-25: "add some debug lines and viz on the taxi to visualize magnets,
 * lane snapping, steer assist, and joystick adjustment/squash"). `V`, the Drive panel's Viz button,
 * or `?driveviz` turns it on. Reads `freeDrive.debug`, which the model fills every frame, and never
 * writes to anything the model reads.
 *
 * **On the ground, round the taxi** (drawn over everything, depth test off):
 * - the *stick ring*: every thumb angle, placed at the ground heading it asks for. Solid street
 *   colour where that push snaps to a street, dim where it is a free heading. With the tilt
 *   corrected out the four snap arcs are even; at `stickCorrect` 1 they bunch up.
 * - headings from the taxi: the nose (white), the push read exactly as drawn (grey), the push with
 *   the tilt correction (blue), the street it snapped to (street colour), and the heading finally
 *   steered for after lane assist (yellow). Where two agree they lie on top of each other.
 * - lane assist: the lane it is pulling toward (green) and a red tick from that lane's centre to
 *   the taxi, the offset it is correcting.
 * - the lane the city thinks the taxi is on (`taxi.lane`, cyan), which the router and cops use.
 * - backing up (brake-to-reverse): a pink arrow off the tail.
 *
 * **On screen, top left**: the stick itself. The ring is the same snap map in thumb angles, the
 * dotted rays are where each street is *drawn* on screen, the white dot is the push, and the blue
 * ray is where the corrected heading is drawn — the gap between the white dot and the blue ray is
 * the squash correction, in the units the thumb feels it.
 */
import * as THREE from 'three';
import { screenToGround, stickMagnet, magnet, viewSquash } from './freedrive.js';

// One colour per street direction (yaw 0 = +X, π/2 = −Z, π = −X, −π/2 = +Z), the same in both
// halves of the overlay. Debug-only, so these stay here rather than in palette.js.
const STREET_COLOURS = [0xff9a3c, 0x2cc3ad, 0x57c157, 0xa97cf0];
const FREE = 0x9aa1ad;
const NOSE = 0xffffff;
const EXACT = 0x9aa1ad;
const CORRECTED = 0x4d8bff;
const TARGET = 0xffd21f;
const LANE_KEEP = 0x3ddc84;
const LANE_OFF = 0xff5a4a;
const LANE_CITY = 0x3fd8ff;
const REVERSE = 0xff3b6b;

const RING_R = 9;
const RING_STEP = 2;            // degrees of thumb per ring sample
const LIFT = 0.35;              // above the road, under nothing (depth test is off anyway)
const MAX_SEGMENTS = 2048;

const css = (hex) => `#${hex.toString(16).padStart(6, '0')}`;
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const quarterOf = (yaw) => ((Math.round(yaw / (Math.PI / 2)) % 4) + 4) % 4;

/**
 * @param scene      where the ground lines go
 * @param taxi       the traffic model's taxi (`x`, `z`, `yaw`, `lane`, `s`)
 * @param freeDrive  the free-driving model: `debug`, `tune`, `toScreen`, `active()`
 * @param on         start switched on
 */
export function createDriveDebug({ scene, taxi, freeDrive, on = false }) {
  let enabled = on;

  // --- The ground lines: one dynamic LineSegments, rebuilt each frame it is visible.
  const positions = new Float32Array(MAX_SEGMENTS * 2 * 3);
  const colours = new Float32Array(MAX_SEGMENTS * 2 * 3);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3).setUsage(THREE.DynamicDrawUsage));
  geometry.setAttribute('color', new THREE.BufferAttribute(colours, 3).setUsage(THREE.DynamicDrawUsage));
  const lines = new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({
    vertexColors: true, depthTest: false, depthWrite: false, transparent: true, toneMapped: false, fog: false,
  }));
  lines.renderOrder = 999;
  // Its vertices move every frame; a bounding sphere latched once would cull it (see CLAUDE.md).
  lines.frustumCulled = false;
  lines.visible = false;
  lines.userData.zfight = false; // debug lines, drawn over everything by design
  scene.add(lines);

  let n = 0;
  const colour = new THREE.Color();
  function seg(x0, z0, x1, z1, hex, y = LIFT) {
    if (n >= MAX_SEGMENTS) return;
    colour.setHex(hex);
    const i = n * 6;
    positions.set([x0, y, z0, x1, y, z1], i);
    colours.set([colour.r, colour.g, colour.b, colour.r, colour.g, colour.b], i);
    n++;
  }
  // A heading from the taxi, `len` long, with a small head. Yaw: 0 = +X, π/2 = −Z.
  function ray(yaw, len, hex, y = LIFT) {
    const fx = Math.cos(yaw);
    const fz = -Math.sin(yaw);
    const ex = taxi.x + fx * len;
    const ez = taxi.z + fz * len;
    // Three strands across, for the same one-pixel reason as the ring.
    const sx = -fz * 0.06;
    const sz = fx * 0.06;
    for (const o of [-1, 0, 1]) seg(taxi.x + sx * o, taxi.z + sz * o, ex + sx * o, ez + sz * o, hex, y);
    for (const side of [-1, 1]) {
      const a = yaw + Math.PI - side * 0.45;
      seg(ex, ez, ex + Math.cos(a) * 0.9, ez - Math.sin(a) * 0.9, hex, y);
    }
  }

  // --- The stick, on screen.
  const SIZE = 236;
  const canvas = document.createElement('canvas');
  canvas.id = 'drive-debug-stick';
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = SIZE * dpr;
  canvas.height = (SIZE + 110) * dpr;
  Object.assign(canvas.style, {
    position: 'fixed', left: 'calc(12px + env(safe-area-inset-left, 0px))', top: 'calc(64px + env(safe-area-inset-top, 0px))',
    width: `${SIZE}px`, height: `${SIZE + 110}px`, pointerEvents: 'none', zIndex: 60,
    background: 'rgba(14, 16, 20, 0.72)', borderRadius: '12px',
  });
  // `display`, not `hidden`: the page's `canvas { display: block }` outranks the attribute, and the
  // empty panel stayed on screen with the overlay off.
  canvas.style.display = 'none';
  document.body.append(canvas);
  const ctx = canvas.getContext('2d');

  /** What a thumb at screen angle `t` (0 = right, π/2 = up) does: its ground heading, and the street it snaps to or -1. */
  function thumbResult(t) {
    const { tune, toScreen, debug } = freeDrive;
    const sx = Math.cos(t);
    const sy = -Math.sin(t);
    const g = screenToGround(sx, sy, toScreen, tune.stickCorrect);
    if (!g) return null;
    const yaw = Math.atan2(-g.z, g.x);
    let snap = null;
    if (tune.magnetOnStick) snap = stickMagnet(sx, sy, toScreen, tune.stickCorrect, debug.assistRad);
    else {
      const m = magnet(yaw, debug.assistRad);
      if (m !== yaw) snap = m;
    }
    return { yaw, street: snap == null ? -1 : quarterOf(snap) };
  }

  function drawGround() {
    n = 0;
    const d = freeDrive.debug;
    // The stick ring — only meaningful where the stick picks a heading, not a turn.
    if (!d.turnMode) {
      let prev = null;
      for (let deg = 0; deg <= 360; deg += RING_STEP) {
        const r = thumbResult((deg * Math.PI) / 180);
        if (!r) { prev = null; continue; }
        const px = taxi.x + Math.cos(r.yaw) * RING_R;
        const pz = taxi.z - Math.sin(r.yaw) * RING_R;
        if (prev && Math.abs(wrap(r.yaw - prev.yaw)) < 0.6) {
          const hex = r.street >= 0 ? STREET_COLOURS[r.street] : FREE;
          // WebGL lines are one pixel whatever `linewidth` says, so a thick arc is several rings: a
          // snap arc six of them across half a unit, a free one two.
          const rings = r.street >= 0 ? 6 : 2;
          for (let q = 0; q < rings; q++) {
            const k = (RING_R + q * 0.1) / RING_R;
            seg(taxi.x + (prev.x - taxi.x) * k, taxi.z + (prev.z - taxi.z) * k,
              taxi.x + (px - taxi.x) * k, taxi.z + (pz - taxi.z) * k, hex);
          }
        }
        prev = { x: px, z: pz, yaw: r.yaw };
      }
    }
    // The city's lane, for the router and the cops.
    const lane = taxi.lane;
    if (lane?.path) {
      const a = lane.path.at(0);
      const b = lane.path.at(lane.length);
      seg(a.x, a.z, b.x, b.z, LANE_CITY, LIFT - 0.05);
    }
    // Lane assist: the lane it pulls toward, and the offset from it.
    if (d.keep) {
      const k = d.keep;
      seg(k.ax, k.az, k.bx, k.bz, LANE_KEEP);
      const len = Math.hypot(k.bx - k.ax, k.bz - k.az) || 1;
      const tx = (k.bx - k.ax) / len;
      const tz = (k.bz - k.az) / len;
      const along = (taxi.x - k.ax) * tx + (taxi.z - k.az) * tz;
      seg(k.ax + tx * along, k.az + tz * along, taxi.x, taxi.z, LANE_OFF);
    }
    // Headings, shortest first so the longer ones read past them.
    ray(taxi.yaw, 4.5, NOSE);
    // Backing up: an arrow off the tail, the way the car is moving.
    if (d.reverse) ray(taxi.yaw + Math.PI, 6, REVERSE);
    if (d.exact != null) ray(d.exact, 9, EXACT);
    if (d.corrected != null) ray(d.corrected, 10, CORRECTED);
    if (d.snapped != null) ray(d.snapped, 11, STREET_COLOURS[quarterOf(d.snapped)]);
    if (d.target != null) ray(d.target, 12.5, TARGET);
    geometry.setDrawRange(0, n * 2);
    geometry.attributes.position.needsUpdate = true;
    geometry.attributes.color.needsUpdate = true;
  }

  function drawStick() {
    const { tune, toScreen, debug: d } = freeDrive;
    const w = SIZE;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, w + 110);
    const cx = w / 2;
    const cy = w / 2;
    const R = w / 2 - 22;
    // The snap map in thumb angles. Canvas y runs down, thumb angles run up.
    if (!d.turnMode) {
      for (let deg = 0; deg < 360; deg += RING_STEP) {
        const r = thumbResult(((deg + RING_STEP / 2) * Math.PI) / 180);
        if (!r) continue;
        ctx.beginPath();
        ctx.strokeStyle = css(r.street >= 0 ? STREET_COLOURS[r.street] : FREE);
        ctx.lineWidth = r.street >= 0 ? 9 : 4;
        ctx.arc(cx, cy, R + 8, (-deg * Math.PI) / 180, (-(deg + RING_STEP + 0.3) * Math.PI) / 180, true);
        ctx.stroke();
      }
    }
    ctx.beginPath();
    ctx.fillStyle = 'rgba(255,255,255,0.06)';
    ctx.strokeStyle = 'rgba(255,255,255,0.25)';
    ctx.lineWidth = 1;
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    // Where each street is drawn on screen: dotted.
    ctx.setLineDash([2, 3]);
    for (let q = 0; q < 4; q++) {
      const yaw = (q * Math.PI) / 2;
      const s = toScreen(Math.cos(yaw), -Math.sin(yaw));
      const l = Math.hypot(s.x, s.y) || 1;
      ctx.beginPath();
      ctx.strokeStyle = css(STREET_COLOURS[q]);
      ctx.lineWidth = 1.5;
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx + (s.x / l) * (R + 14), cy + (s.y / l) * (R + 14));
      ctx.stroke();
    }
    ctx.setLineDash([]);
    // The push, and where its corrected heading is drawn.
    const p = d.push;
    if (p && !d.turnMode) {
      const l = Math.hypot(p.dx, p.dy) || 1;
      if (d.corrected != null) {
        const s = toScreen(Math.cos(d.corrected), -Math.sin(d.corrected));
        const sl = Math.hypot(s.x, s.y) || 1;
        ctx.beginPath();
        ctx.strokeStyle = css(CORRECTED);
        ctx.lineWidth = 2.5;
        ctx.moveTo(cx, cy);
        ctx.lineTo(cx + (s.x / sl) * R, cy + (s.y / sl) * R);
        ctx.stroke();
      }
      if (d.target != null) {
        const s = toScreen(Math.cos(d.target), -Math.sin(d.target));
        const sl = Math.hypot(s.x, s.y) || 1;
        ctx.beginPath();
        ctx.strokeStyle = css(TARGET);
        ctx.lineWidth = 2;
        ctx.moveTo(cx, cy);
        ctx.lineTo(cx + (s.x / sl) * R * 0.8, cy + (s.y / sl) * R * 0.8);
        ctx.stroke();
      }
      ctx.beginPath();
      ctx.fillStyle = '#fff';
      ctx.arc(cx + (p.dx / l) * R * 0.92, cy + (p.dy / l) * R * 0.92, 6, 0, Math.PI * 2);
      ctx.fill();
    } else if (p && d.turnMode) {
      ctx.beginPath();
      ctx.fillStyle = '#fff';
      const k = Math.max(-1, Math.min(1, p.dx / 34));
      ctx.arc(cx + k * R, cy, 6, 0, Math.PI * 2);
      ctx.fill();
    }
    // The numbers.
    const squash = viewSquash(toScreen);
    const deg = (a) => (a == null ? '—' : `${Math.round((((a * 180) / Math.PI) % 360 + 360) % 360)}°`);
    const thumb = p ? deg(Math.atan2(-p.dy, p.dx)) : '—';
    const rows = d.turnMode
      ? [['mode', 'turn'], ['push', p ? (p.dx / 34).toFixed(2) : '—']]
      : [
        ['squash', `${squash ? squash.toFixed(3) : '—'}  correct ${tune.stickCorrect.toFixed(2)}`],
        ['thumb', `${thumb}  magnet ±${Math.round((d.assistRad * 180) / Math.PI)}° ${tune.magnetOnStick ? 'stick' : 'ground'}`],
        ['heading', `exact ${deg(d.exact)}  corr ${deg(d.corrected)}`],
        ['snap', d.snapped != null ? `street ${deg(d.snapped)}` : 'free'],
        ['slide', `${Math.abs(d.slip ?? 0).toFixed(1)} u/s sideways${d.drifting ? '  DRIFT' : ''}`],
        ['reverse', d.reverse ? 'backing up' : d.reverseClock > 0 ? `brake held ${d.reverseClock.toFixed(2)}s` : '—'],
        ['lane', d.keep ? `${d.keep.lat.toFixed(2)}u off → ${((d.keep.bend * 180) / Math.PI).toFixed(1)}° (${Math.round(d.keep.share * 100)}%)` : '—'],
      ];
    ctx.font = '11px ui-monospace, Menlo, monospace';
    ctx.textBaseline = 'top';
    rows.forEach(([k, v], i) => {
      ctx.fillStyle = 'rgba(255,255,255,0.55)';
      ctx.fillText(k, 10, w - 6 + i * 15);
      ctx.fillStyle = '#fff';
      ctx.fillText(v, 62, w - 6 + i * 15);
    });
  }

  function update() {
    const show = enabled && freeDrive.active() && !taxi.crashed;
    lines.visible = show;
    canvas.style.display = show ? 'block' : 'none';
    if (!show) return;
    drawGround();
    drawStick();
  }

  window.addEventListener('keydown', (event) => {
    if (event.repeat || event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key !== 'v' && event.key !== 'V') return;
    if (event.target instanceof HTMLElement && event.target.closest('input[type="text"], input[type="search"], textarea')) return;
    enabled = !enabled;
    onToggle?.();
  });
  let onToggle = null;

  return {
    update,
    on: () => enabled,
    set(v) { enabled = Boolean(v); },
    /** Called when `V` flips it, so the Drive panel can repaint its button. */
    onToggle(fn) { onToggle = fn; },
  };
}
