// Physics-mode toggle. Selects which car-physics implementation runs this session.
//
// Read once at boot by the two physics branches (arcade tilt/roll; rigid-body bubble)
// so each can gate itself. This module is a pure lookup -- it must NOT import three,
// traffic, or anything with side effects, so it's safe to pull into headless code paths
// (tools/check.mjs BOOT list, tools/probe.mjs, etc.) without dragging in WASM.
//
// Query string: ?physics=off | arcade | rigid   (default off)

export const MODES = Object.freeze({
  OFF: 'off',
  ARCADE: 'arcade',
  RIGID: 'rigid',
});

const VALID = new Set(Object.values(MODES));

export function getPhysicsMode() {
  // Headless (Node) has no window -- physics stays off so probe/check/taxi tools
  // don't need to think about it.
  if (typeof window === 'undefined' || !window.location) return MODES.OFF;
  const params = new URLSearchParams(window.location.search);
  const raw = params.get('physics');
  if (raw == null) return MODES.OFF;
  const v = raw.toLowerCase();
  return VALID.has(v) ? v : MODES.OFF;
}

export function isArcade() {
  return getPhysicsMode() === MODES.ARCADE;
}

export function isRigid() {
  return getPhysicsMode() === MODES.RIGID;
}
