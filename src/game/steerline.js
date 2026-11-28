/**
 * The stick's debug line: what the stick is saying, drawn off the taxi's nose (Tyler, 2026-11-24:
 * "a simple debug line from the front of the taxi that maps to the thumbstick so we can get some
 * feedback on where the taxi is headed / steering is pointing"). `?steerline=off` hides it.
 *
 * Two lines, in screen space, because the question is about the screen — does the thumb's angle
 * land on the street the player meant:
 *
 * - **thin white:** the raw thumb, the exact angle the knob is pushed, while held.
 * - **thick yellow:** the street that push snapped to, along that street as drawn; after the thumb
 *   lifts, the turn still queued, dimmer. Nothing queued and nothing held, no line.
 * - **cyan, always:** what the taxi will actually do at the junction ahead — the exit it has
 *   committed to once it is past the hold line, the one its route names before that. Where yellow
 *   and cyan disagree, the car is not doing what the stick says, which is the thing to report.
 *
 * An SVG over the canvas rather than a mesh: it is a debug aid, it wants to sit on top of
 * everything, and it is drawn in the same pixels the stick is read in.
 */
import { PALETTE } from '../palette.js';
import { TAXI_TAILPIPE_BACK } from '../geometry/taxi.js';

const DIR_VEC = [[1, 0], [0, 1], [-1, 0], [0, -1]];
const RAW_PX = 64;
const STREET_PX = 88;
const PLAN_PX = 48;
const NS = 'http://www.w3.org/2000/svg';

/**
 * @param project   (x, y, z) => {x, y} — world to viewport pixels
 * @param toScreen  `(dx, dz) => { x, y }`, a world ground vector in screen pixels
 * @param taxi      the taxi car
 * @param stick     game/joystick.js's handle (`vector()`, `picked()`)
 * @param steer     game/steer.js's controller (`queued()`)
 * @param canShow   () => boolean
 */
export function createSteerLine({ project, toScreen, taxi, stick, steer, canShow }) {
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('id', 'steer-line');
  svg.setAttribute('aria-hidden', 'true');
  Object.assign(svg.style, {
    position: 'fixed', inset: '0', width: '100vw', height: '100vh',
    pointerEvents: 'none', zIndex: '5', overflow: 'visible',
  });
  const line = (colour, width) => {
    const el = document.createElementNS(NS, 'line');
    el.setAttribute('stroke', colour);
    el.setAttribute('stroke-width', String(width));
    el.setAttribute('stroke-linecap', 'round');
    svg.appendChild(el);
    return el;
  };
  const plan = line(PALETTE.steerLinePlan, 4);
  const street = line(PALETTE.steerLineStreet, 5);
  const raw = line(PALETTE.steerLineStick, 2);
  const tip = document.createElementNS(NS, 'circle');
  tip.setAttribute('r', '6');
  tip.setAttribute('fill', PALETTE.steerLineStreet);
  svg.appendChild(tip);
  document.body.appendChild(svg);

  const draw = (el, x0, y0, ux, uy, len, show) => {
    el.style.display = show ? '' : 'none';
    if (!show) return;
    el.setAttribute('x1', x0); el.setAttribute('y1', y0);
    el.setAttribute('x2', x0 + ux * len); el.setAttribute('y2', y0 + uy * len);
  };

  function update() {
    if (!canShow()) { svg.style.display = 'none'; return; }
    svg.style.display = '';
    // The nose: yaw 0 points down +X and −π/2 down +Z (`dirYaw` in city/grid.js).
    const fx = Math.cos(taxi.yaw);
    const fz = -Math.sin(taxi.yaw);
    const nose = project(taxi.x + fx * TAXI_TAILPIPE_BACK, 0.6, taxi.z + fz * TAXI_TAILPIPE_BACK);

    // The junction ahead: committed past the hold line (`dOut`), otherwise the one-step route.
    const next = taxi.state === 'turn' ? taxi.dOut : (taxi.route?.[0] ?? taxi.d);
    if (next != null) {
      const s = toScreen(DIR_VEC[next][0], DIR_VEC[next][1]);
      const l = Math.hypot(s.x, s.y) || 1;
      draw(plan, nose.x, nose.y, s.x / l, s.y / l, PLAN_PX, true);
    } else draw(plan, 0, 0, 0, 0, 0, false);

    const v = stick.vector();
    const held = Boolean(v && v.len > 0);
    draw(raw, nose.x, nose.y, held ? v.dx / v.len : 0, held ? v.dy / v.len : 0, RAW_PX, held);

    const dir = stick.picked() ?? steer.queued();
    let ux = 0;
    let uy = 0;
    if (dir != null) {
      const s = toScreen(DIR_VEC[dir][0], DIR_VEC[dir][1]);
      const l = Math.hypot(s.x, s.y) || 1;
      ux = s.x / l; uy = s.y / l;
    }
    draw(street, nose.x, nose.y, ux, uy, STREET_PX, dir != null);
    const fade = stick.picked() != null ? '1' : '0.5';
    street.style.opacity = fade;
    tip.style.display = dir != null ? '' : 'none';
    tip.style.opacity = fade;
    tip.setAttribute('cx', nose.x + ux * STREET_PX);
    tip.setAttribute('cy', nose.y + uy * STREET_PX);
  }

  return { update };
}
