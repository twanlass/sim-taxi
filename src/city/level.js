import { GRID, segmentKey } from './grid.js';

// A level is: block types per cell, road segments closed off, arterial lines with a coordinated
// direction, and — optionally — where the taxi should spawn. That's the whole shape the editor
// authors and the loader (src/city/layout.js:layoutFromLevel) consumes.
//
// The format is intentionally close to the runtime layout so serialise/deserialise stays a data
// copy with no interpretation. Changes to gameplay shape belong in layout.js; changes to the
// wire format belong here.

export const LEVEL_VERSION = 1;

const BLOCK_TYPES = new Set(['built', 'park', 'plaza']);

/**
 * Return an array of error strings for a candidate level, empty if valid. Throwing was tempting
 * but the editor wants to surface everything wrong at once rather than one-at-a-time.
 */
export function validate(level) {
  const errors = [];
  if (!level || typeof level !== 'object') return ['not an object'];
  if (level.version !== LEVEL_VERSION) errors.push(`version ${level.version} != ${LEVEL_VERSION}`);
  if (level.grid !== GRID) errors.push(`grid ${level.grid} != ${GRID}`);

  if (!Array.isArray(level.blocks)) errors.push('blocks: not an array');
  else {
    const seen = new Set();
    for (const b of level.blocks) {
      if (!Number.isInteger(b?.bi) || !Number.isInteger(b?.bj)) errors.push(`block: bad indices ${JSON.stringify(b)}`);
      else if (b.bi < 0 || b.bi >= GRID || b.bj < 0 || b.bj >= GRID) errors.push(`block ${b.bi},${b.bj}: out of range`);
      else if (!BLOCK_TYPES.has(b.type)) errors.push(`block ${b.bi},${b.bj}: unknown type "${b.type}"`);
      else if (seen.has(`${b.bi},${b.bj}`)) errors.push(`block ${b.bi},${b.bj}: duplicate entry`);
      else seen.add(`${b.bi},${b.bj}`);
    }
  }

  if (!Array.isArray(level.closed)) errors.push('closed: not an array');

  const art = level.arterials ?? {};
  if (art.x && !Array.isArray(art.x)) errors.push('arterials.x: not an array');
  if (art.z && !Array.isArray(art.z)) errors.push('arterials.z: not an array');

  if (level.taxiStart) {
    const { i, j, d } = level.taxiStart;
    if (!(Number.isInteger(i) && Number.isInteger(j) && Number.isInteger(d))) {
      errors.push('taxiStart: i, j, d must be integers');
    } else if (i < 0 || i > GRID || j < 0 || j > GRID) {
      errors.push('taxiStart: intersection out of range');
    } else if (d < 0 || d > 3) {
      errors.push('taxiStart: direction must be 0..3');
    }
  }

  return errors;
}

/**
 * Turn a live block array (as returned by layoutFromLevel/proceduralLayout) plus its arterial
 * config back into a JSON level. Used by the editor's Export and by check.mjs for round-trips.
 *
 * The arterial config is read from the array's own `arterials` tail — that's where both layout
 * paths park it, so callers don't have to know where the sim's SIGNAL state lives.
 */
export function serialize(blocks, { taxiStart = null } = {}) {
  const arterials = blocks.arterials ?? { x: new Set(), z: new Set(), dirX: new Map(), dirZ: new Map() };
  const dirXObj = {};
  const dirZObj = {};
  for (const [k, v] of arterials.dirX ?? []) dirXObj[k] = v;
  for (const [k, v] of arterials.dirZ ?? []) dirZObj[k] = v;

  return {
    version: LEVEL_VERSION,
    grid: GRID,
    blocks: blocks.map((b) => ({
      bi: b.bi,
      bj: b.bj,
      type: b.type,
      ...(b.districtId !== null && b.districtId !== undefined ? { districtId: b.districtId } : {}),
    })),
    closed: [...(blocks.closed ?? [])].sort(),
    arterials: {
      x: [...(arterials.x ?? [])].sort((a, b) => a - b),
      z: [...(arterials.z ?? [])].sort((a, b) => a - b),
      dirX: dirXObj,
      dirZ: dirZObj,
    },
    ...(taxiStart ? { taxiStart } : {}),
  };
}

/**
 * Editor state → JSON. The editor holds things as plain maps/sets keyed by cell/line, so we
 * assemble a level directly rather than routing through a temporary layout.
 */
export function editorStateToLevel(state) {
  const blocks = [];
  for (const [key, type] of state.cellTypes) {
    if (type === 'built') continue;   // built is the default, no need to spell it out
    const [bi, bj] = key.split(',').map(Number);
    const districtId = state.districtOf.get(key);
    blocks.push({
      bi, bj, type,
      ...(districtId !== undefined && type === 'park' ? { districtId } : {}),
    });
  }
  const dirXObj = {};
  const dirZObj = {};
  for (const [k, v] of state.dirX) dirXObj[k] = v;
  for (const [k, v] of state.dirZ) dirZObj[k] = v;
  return {
    version: LEVEL_VERSION,
    grid: GRID,
    blocks,
    closed: [...state.closed].sort(),
    arterials: {
      x: [...state.arterialX].sort((a, b) => a - b),
      z: [...state.arterialZ].sort((a, b) => a - b),
      dirX: dirXObj,
      dirZ: dirZObj,
    },
    ...(state.taxiStart ? { taxiStart: { ...state.taxiStart } } : {}),
  };
}

/** JSON level → the editor's mutable state. Symmetric to editorStateToLevel above. */
export function levelToEditorState(level) {
  const cellTypes = new Map();
  const districtOf = new Map();
  for (const b of level.blocks ?? []) {
    if (b.type && b.type !== 'built') cellTypes.set(`${b.bi},${b.bj}`, b.type);
    if (b.districtId !== undefined && b.districtId !== null) {
      districtOf.set(`${b.bi},${b.bj}`, b.districtId);
    }
  }
  return {
    cellTypes,
    districtOf,
    closed: new Set(level.closed ?? []),
    arterialX: new Set(level.arterials?.x ?? []),
    arterialZ: new Set(level.arterials?.z ?? []),
    dirX: new Map(Object.entries(level.arterials?.dirX ?? {}).map(([k, v]) => [Number(k), v])),
    dirZ: new Map(Object.entries(level.arterials?.dirZ ?? {}).map(([k, v]) => [Number(k), v])),
    taxiStart: level.taxiStart ? { ...level.taxiStart } : null,
  };
}

// --- URL and storage handoff ------------------------------------------------
//
// Two ways the app receives a level at boot:
//   ?level=session — the editor has just clicked "Play"; read the last-saved level out of
//                    sessionStorage and boot from that. Survives the reload, not the tab.
//   ?level=raw:X   — a shareable link; the level is packed into the URL itself as
//                    base64url-encoded JSON, so nothing needs a backend.

export const SESSION_KEY = 'simTaxi.level';

/** UTF-8 safe base64url encode / decode. Works in browsers and in Node 18+ (used by check.mjs). */
export function encodeUrl(level) {
  const bytes = new TextEncoder().encode(JSON.stringify(level));
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  const b64 = (typeof btoa === 'function' ? btoa(bin) : Buffer.from(bin, 'binary').toString('base64'));
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function decodeUrl(encoded) {
  const b64 = encoded.replace(/-/g, '+').replace(/_/g, '/');
  const padded = b64 + '='.repeat((4 - b64.length % 4) % 4);
  const bin = (typeof atob === 'function' ? atob(padded) : Buffer.from(padded, 'base64').toString('binary'));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return JSON.parse(new TextDecoder().decode(bytes));
}

/**
 * A pair of adjacent park blocks pair up into a district and close the road between them.
 * Given a set of cell keys already marked as park, this returns the segmentKey to close for the
 * two cells named — or null if the pair isn't valid. The editor uses this when pairing park
 * blocks so the closure and the districtId are decided in one place.
 */
export function segmentBetween(bi1, bj1, bi2, bj2) {
  const di = bi2 - bi1;
  const dj = bj2 - bj1;
  if (Math.abs(di) + Math.abs(dj) !== 1) return null;   // not adjacent
  // The road between two blocks (bi, bj) and (bi+1, bj) is the one running along the shared edge
  // at intersection line i = bi+1, spanning from j = bj to j = bj+1.
  if (di === 1)  return segmentKey(bi2, bj1,     bi2, bj1 + 1);
  if (di === -1) return segmentKey(bi1, bj1,     bi1, bj1 + 1);
  if (dj === 1)  return segmentKey(bi1, bj2,     bi1 + 1, bj2);
  return             segmentKey(bi1, bj1,     bi1 + 1, bj1);
}

