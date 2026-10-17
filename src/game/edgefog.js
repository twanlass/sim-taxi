import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import {
  BIG_CITY, HALF_SPAN_X, HALF_SPAN_Z, HALF_ROAD, GRID_I, GRID_J, PITCH, BLOCK, lineX, lineZ, riverRow,
} from '../city/grid.js';
import { bakeColor, propMaterial, unlitMaterial } from '../util/geo.js';
import { color, jitterColor } from '../palette.js';

// --- The fog of war round the island -------------------------------------------------------------
//
// A bank of soft white fog wrapped round the city, the way an RTS hides the map you have not
// explored: the ring road runs along its inner edge, and past it there is no coast, no sky and no
// end to the ground — only fog, with the tops of the outermost buildings standing up out of it. It
// hides where the island stops and leaves the question of what is out there open, which is the
// point (Tyler, 2026-10-17: "gives the illusion you could unlock more city later").
//
// **It is a fog term, not a mesh laid over the city.** A sheet of translucent fog geometry would be
// the obvious build and costs the one thing a phone has least of: full-screen overdraw, once per
// layer, every frame. This instead adds a second term to three's own fog chunk, so every material
// that already wears the scene's haze also mixes toward the fog by where it stands on the *map*:
// ShaderChunk is patched once at import, before anything compiles, so there is no per-material
// patch to forget and no `customProgramCacheKey` to keep honest — every program simply has it.
// Materials with `fog: false` (the sky dome, the HUD-like markers) are untouched, because the whole
// term lives inside three's own `USE_FOG` guard.
//
// The shape is a signed distance to a rounded rectangle round the ring road's outer kerbs, roughened
// by two octaves of drifting value noise so the edge billows rather than reading as a vignette. The
// distance is measured **minus the fragment's height**, so the bank has a sloped top: a roof eight
// units up needs to stand eight units further out before the fog takes it, and the outermost
// buildings come up out of it rather than being washed flat with their own pavement.
//
// The ground beyond the island is a floor (`createEdgeFogFloor`) that the fog takes completely. It
// sits below the river's bed so it can never cover the channel, and it is what stands in for the
// sky everywhere past the coast — without it the fog would be a white rim with sky behind it, which
// is the old feathered edge in a different colour.
//
// Off on `?city=big` — the bigger map is the "unlocked" city, so it keeps its harbor, shores and
// horizon in view — and off with `?edgefog=classic` (`EDGEFOG=classic` headless), which brings back
// the island fading into the sky.

const CLASSIC = typeof location !== 'undefined'
  ? new URLSearchParams(location.search).get('edgefog') === 'classic'
  : globalThis.process?.env?.EDGEFOG === 'classic';

export const EDGE_FOG = !BIG_CITY && !CLASSIC;

/** The rectangle the fog is measured from: the outer kerb of the ring road, on each axis. */
export const FOG_HALF_X = HALF_SPAN_X + HALF_ROAD;
export const FOG_HALF_Z = HALF_SPAN_Z + HALF_ROAD;
/** Its corner radius — round enough that the corners read as a bank and not as a frame. */
export const FOG_RADIUS = 14;
/**
 * Where the ramp starts and ends, in units past that kerb (negative is inside it), before the
 * billows push it outward.
 *
 * It starts a unit **inside** the kerb so the ring road's outer lane carries a breath of it — a fog
 * that begins exactly where the road ends draws the road's edge as its own edge, which is the line
 * this is meant to hide.
 */
export const FOG_START = -1;
export const FOG_END = 7;
/**
 * How far the noise pushes the edge **outward**, in world units. Outward only, and that is a
 * gameplay rule rather than a look: the first cut billowed ±7 either way, and on the near (south
 * and east) side a hollow in the noise rolled the bank right across the ring road the taxi drives.
 * Pushing one way keeps `FOG_START` a hard limit on how far in the fog can ever reach.
 */
export const FOG_BILLOW = 8;
/** How much a unit of height pushes the bank back: 1 = a 45° slope off the ground. */
export const FOG_SLOPE = 1.1;
/** How fast the billows drift, in world units per second. Slow: weather, not smoke. */
export const FOG_DRIFT = [0.55, 0.25];
/**
 * How much of a tall thing still shows through the thickest fog — 0 swallows it entirely. Without it
 * the blocks past the edge were either standing clear of the bank (a wall of bare boxes) or gone,
 * with nothing in between; this is the in between.
 */
export const FOG_SILHOUETTE = 0.22;
/** The floor's depth: under the river's bed (the channel is 2 down), so it never covers it. */
export const FLOOR_Y = -6;

/**
 * The uniform every fogged program reads: rgb is the fog's lit colour, w is time in seconds.
 *
 * A **plain object**, not a `THREE.Vector4`, and that is load-bearing. Three hands each material a
 * clone of its shader's uniforms, and `cloneUniforms` deep-copies anything that is a vector, colour
 * or matrix but passes any other object across by reference — so this one object is shared by
 * every material in the scene, and moving it once a frame moves them all. A Vector4 here would be
 * copied into a few hundred materials at their first render and never move again.
 *
 * A material that never got it (a ShaderMaterial built before this module loaded, or one that
 * merged its own fog uniforms) reads vec4(0), and the shader takes a black colour as "not wired"
 * and skips the term rather than painting a black fog.
 */
export const edgeFogUniform = { x: 0.93, y: 0.96, z: 0.98, w: 0 };

const f = (n) => n.toFixed(3);

const PARS_VERTEX = /* glsl */ `
#ifdef USE_FOG
	varying vec3 vEdgeFogWorld;
#endif
`;

// mvPosition is in view space with instancing and skinning already applied, and the view matrix is
// rigid, so its transpose undoes the rotation — cheaper than an inverse, and correct for every
// kind of mesh that reaches fog_vertex.
const VERTEX = /* glsl */ `
#ifdef USE_FOG
	vEdgeFogWorld = transpose( mat3( viewMatrix ) ) * ( mvPosition.xyz - viewMatrix[ 3 ].xyz );
#endif
`;

const PARS_FRAGMENT = /* glsl */ `
#ifdef USE_FOG
	uniform vec4 edgeFog;
	varying vec3 vEdgeFogWorld;
	float edgeFogHash( vec2 p ) {
		return fract( sin( dot( p, vec2( 127.1, 311.7 ) ) ) * 43758.5453 );
	}
	float edgeFogNoise( vec2 p ) {
		vec2 i = floor( p );
		vec2 u = fract( p );
		u = u * u * ( 3.0 - 2.0 * u );
		return mix(
			mix( edgeFogHash( i ), edgeFogHash( i + vec2( 1.0, 0.0 ) ), u.x ),
			mix( edgeFogHash( i + vec2( 0.0, 1.0 ) ), edgeFogHash( i + vec2( 1.0, 1.0 ) ), u.x ),
			u.y );
	}
#endif
`;

const FRAGMENT = /* glsl */ `
#ifdef USE_FOG
	if ( edgeFog.x + edgeFog.y + edgeFog.z > 0.0 ) {
		vec2 efp = vEdgeFogWorld.xz;
		vec2 efq = abs( efp ) - vec2( ${f(FOG_HALF_X - FOG_RADIUS)}, ${f(FOG_HALF_Z - FOG_RADIUS)} );
		float efd = length( max( efq, 0.0 ) ) + min( max( efq.x, efq.y ), 0.0 ) - ${f(FOG_RADIUS)};
		vec2 efw = efp - vec2( ${f(FOG_DRIFT[0])}, ${f(FOG_DRIFT[1])} ) * edgeFog.w;
		float efn = edgeFogNoise( efw * 0.06 ) * 0.65 + edgeFogNoise( efw * 0.17 + 7.3 ) * 0.35;
		float efh = max( vEdgeFogWorld.y, 0.0 ) * ${f(FOG_SLOPE)};
		float efa = smoothstep( ${f(FOG_START)}, ${f(FOG_END)}, efd - efn * ${f(FOG_BILLOW)} - efh );
		// The floor is the fog itself, wherever it shows: through the island's feathered skirt as
		// much as past it. Partly fogged it would show its own plain colour as a pale band.
		if ( vEdgeFogWorld.y < ${f(FLOOR_Y + 1)} ) efa = 1.0;
		efa = 1.0 - ( 1.0 - efa ) * ( 1.0 - efa ) * ( 1.0 - efa );
		// Anything standing tall is never quite swallowed: a shadow of it stays in the bank, which is
		// how the blocks past the edge read as buildings in the fog rather than not being there.
		efa = min( efa, 1.0 - ${f(FOG_SILHOUETTE)} * smoothstep( 3.0, 14.0, vEdgeFogWorld.y ) );
		// The billows' own shading: the noise's crests a shade brighter than its hollows, so the
		// bank has bodies in it rather than being one flat sheet of colour.
		vec3 efc = edgeFog.xyz * ( 0.86 + 0.2 * efn );
		gl_FragColor.rgb = mix( gl_FragColor.rgb, efc, efa );
	}
#endif
`;

if (EDGE_FOG) {
  const chunk = THREE.ShaderChunk;
  chunk.fog_pars_vertex += PARS_VERTEX;
  chunk.fog_vertex += VERTEX;
  chunk.fog_pars_fragment += PARS_FRAGMENT;
  chunk.fog_fragment += FRAGMENT;
  // Built-in materials take their uniforms from ShaderLib (merged at three's own load, so adding to
  // UniformsLib.fog alone would miss every one of them); ShaderMaterials written in this project
  // merge UniformsLib.fog when they are built, and this module loads before any of them are.
  THREE.UniformsLib.fog.edgeFog = { value: edgeFogUniform };
  for (const shader of Object.values(THREE.ShaderLib)) {
    if (shader.uniforms?.fogColor) shader.uniforms.edgeFog = { value: edgeFogUniform };
  }
}

/** How much the fog lifts the sky's horizon colour toward white. 0 is the sky itself. */
export const FOG_LIFT = 0.45;

const WHITE = new THREE.Color(1, 1, 1);
const tmp = new THREE.Color();

/** Follow the sky: the fog is the dome's horizon colour lifted toward white. daylight.js calls it. */
export function setEdgeFogSky(bottom) {
  tmp.copy(bottom).lerp(WHITE, FOG_LIFT);
  edgeFogUniform.x = tmp.r;
  edgeFogUniform.y = tmp.g;
  edgeFogUniform.z = tmp.b;
}

/** Advance the drift. Sim time, so a paused game holds its fog still and shot mode is repeatable. */
export function tickEdgeFog(seconds) {
  edgeFogUniform.w = seconds;
}

/**
 * The ground past the coast, for the fog to take. A plain unlit plane: whatever colour it is, the
 * fog term replaces it outright, so all it has to do is be there and be fogged.
 */
export function createEdgeFogFloor() {
  const size = 2400;
  const geometry = new THREE.PlaneGeometry(size, size);
  geometry.rotateX(-Math.PI / 2);
  // The one unlit material that *does* take fog — it exists to be fogged, and nothing else.
  const material = unlitMaterial({ color: 0xffffff, fog: true });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.y = FLOOR_Y;
  mesh.name = 'edge-fog-floor';
  mesh.renderOrder = -1;
  return mesh;
}

// --- The city under the fog ------------------------------------------------------------------------
//
// Blocks carry on past the ring road on the grid's own pitch, so the tops of a few buildings stand up
// out of the bank: the one thing that says "there is more city out there" rather than "the world
// ends in cloud". The fog's slope does the work — a roof pokes out only where it is tall enough for
// its distance, so the first ring shows its upper storeys, the second the odd roof, and the third
// nothing at all but a shape where the noise thins.
//
// **Only up-screen: west and north.** The camera looks down the -x-z diagonal, so a building past
// the east or south ring road stands *between* the camera and that road, and its height throws up
// over the very lane the taxi drives — the trap that sized the bank's roof (CLAUDE.md, "a building
// at the wrong height"). Past the west and north edges anything tall stands behind the city.
//
// **The river row stays open**, so the channel runs off into the fog between buildings instead of
// into the side of one.
//
// Plain boxes, one merged mesh, one draw, no shadows and no AO; under the far edge's fog a window is
// a pixel of noise.

/** Rings of blocks past the ring road, and the height range of what stands on them. */
export const GHOST_RINGS = 3;
const GHOST_H = [6, 16];
const GHOST_FAMILIES = ['concrete', 'pale', 'tan', 'brick', 'slate'];

export function createEdgeFogCity(rng) {
  if (!EDGE_FOG) return null;
  const parts = [];
  const river = riverRow();
  for (let bi = -GHOST_RINGS; bi < GRID_I; bi++) {
    for (let bj = -GHOST_RINGS; bj < GRID_J; bj++) {
      if (bi >= 0 && bj >= 0) continue; // the city, and everything east and south of it
      // Not the first ring: it stands a kerb's width off the ring road, too near for any fog that
      // leaves the road clear, and it read as a wall of bare boxes round the city rather than as
      // something glimpsed.
      if (bi > -2 && bj > -2) continue;
      if (bj === river) continue;
      const cx = lineX(bi) + PITCH / 2;
      const cz = lineZ(bj) + PITCH / 2;
      // One to three buildings to a block, in a row along its longer split.
      const n = rng.int(1, 3);
      const alongX = rng.chance(0.5);
      const span = BLOCK - 2;
      for (let k = 0; k < n; k++) {
        const len = span / n - 1;
        const off = -span / 2 + (k + 0.5) * (span / n);
        const w = alongX ? len : span * rng.range(0.6, 0.9);
        const d = alongX ? span * rng.range(0.6, 0.9) : len;
        // Shorter the further out, so the skyline steps down into the bank instead of walling it.
        const ring = Math.max(-bi, -bj);
        const h = rng.range(GHOST_H[0], GHOST_H[1]) * (1 - 0.2 * (ring - 2));
        const box = new THREE.BoxGeometry(w, h, d);
        box.translate(cx + (alongX ? off : 0), h / 2, cz + (alongX ? 0 : off));
        parts.push(bakeColor(box, jitterColor(color(rng.pick(GHOST_FAMILIES)), rng, { l: 0.05 })));
      }
    }
  }
  const geometry = mergeGeometries(parts, false);
  parts.forEach((g) => g.dispose());
  const mesh = new THREE.Mesh(geometry, propMaterial({ ao: false }));
  mesh.name = 'edge-fog-city';
  return mesh;
}
