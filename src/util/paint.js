import * as THREE from 'three';

// Paint in 3D space — the garage's skins (see docs/garage.md).
//
// A skin is a small RGBA volume laid over a vehicle's bounding box, in the vehicle's own unscaled
// local frame. The fragment shader looks its colour up by *where the fragment is on the car*, so
// there are no UVs, no unwrap and no atlas: anything that sits in a painted voxel takes its paint.
//
// That is chosen over a texture atlas for one reason, and it is the reason this project can have a
// paint tool at all: every mesh here is generated in code, and code changes. An atlas keyed to a
// box's faces tears the moment a box is resized; a volume keyed to space doesn't care — the paint
// stays where it was put, and a panel that moves into it picks it up.
//
// **The lookup is by rest position, not live position.** Doors, the bonnet and the boot are their
// own meshes on hinges, so reading the volume at a fragment's live position would leave the paint
// standing in the air while the door swings out from under it. Every painted vertex carries a
// `paintPos` attribute instead (`stampPaintPos`) — where it sits with every hinge shut — and that
// is what the shader samples. A door painted shut is still painted open.
//
// The alpha byte is the mode, not an opacity: 0 is bare (the geometry's own colour shows), PAINT_TINTED
// takes the instance's colour on top (an ambient car's body paint, which `instanceColor` varies per
// car), and PAINT_FIXED ignores it (chrome, a stripe, a decal — the same on every car of the type).
// For a one-off like the taxi the two are identical; the distinction is for the fleets.

export const PAINT_NONE = 0;
export const PAINT_TINTED = 128;
export const PAINT_FIXED = 255;

const SKIN_VERSION = 1;

// How far inside a surface the shader reads the volume, in voxels. A face lying exactly on a cell
// boundary — the taxi's roof is at y = 1.5, which is a whole number of 1/16ths off the skin's
// floor — would otherwise floor() into one cell or the other per fragment on float noise, and paint
// across it would read as speckle. Sinking the sample along the surface's own normal makes every
// face read the cell just behind it, consistently, and a quarter voxel is far less than any panel
// on the car is thick.
const SURFACE_SINK = 0.25;

// --- The codec ----------------------------------------------------------------------------------
//
// A skin is mostly empty space — a painted car covers its surface and nothing inside it — so the
// volume is run-length coded over whole voxels (one uint32 each) and base64'd into the JSON. A bare
// 64×40×36 volume is one run; a fully liveried car measures in the low tens of kB.

function toBase64(bytes) {
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

function fromBase64(text) {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** RGBA bytes → base64 of [count, rgba] uint32 pairs. */
export function encodeVolume(bytes) {
  const voxels = new Uint32Array(bytes.buffer, bytes.byteOffset, bytes.length / 4);
  const runs = [];
  let i = 0;
  while (i < voxels.length) {
    const value = voxels[i];
    let j = i + 1;
    while (j < voxels.length && voxels[j] === value) j++;
    runs.push(j - i, value);
    i = j;
  }
  const packed = new Uint32Array(runs);
  return toBase64(new Uint8Array(packed.buffer));
}

/** The inverse of `encodeVolume`, into `out` (which must be the right length). Throws on a mismatch. */
export function decodeVolume(text, out) {
  const raw = fromBase64(text);
  if (raw.length % 8 !== 0) throw new Error(`paint: corrupt volume (${raw.length} bytes)`);
  const runs = new Uint32Array(raw.buffer, raw.byteOffset, raw.length / 4);
  const voxels = new Uint32Array(out.buffer, out.byteOffset, out.length / 4);
  let at = 0;
  for (let r = 0; r < runs.length; r += 2) {
    const count = runs[r];
    if (at + count > voxels.length) throw new Error('paint: volume overruns its dimensions');
    voxels.fill(runs[r + 1], at, at + count);
    at += count;
  }
  if (at !== voxels.length) {
    throw new Error(`paint: volume holds ${at} voxels, dimensions want ${voxels.length}`);
  }
  return out;
}

/** A fresh, unpainted skin file for a volume over [min, max] at `voxel` units per cell. */
export function blankSkin(min, max, voxel) {
  const dims = min.map((lo, a) => Math.round((max[a] - lo) / voxel));
  return {
    version: SKIN_VERSION,
    min: [...min],
    voxel,
    dims,
    data: encodeVolume(new Uint8Array(dims[0] * dims[1] * dims[2] * 4)),
  };
}

// --- The live skin -------------------------------------------------------------------------------

/**
 * A skin as the game and the garage use it: the bytes, the 3D texture over them, and the uniforms
 * every painted material shares. One per vehicle type — every car of a type reads the same one.
 *
 * Bounds come from the *file*, not from the code, so a skin painted against today's car keeps its
 * paint in the same place in space if tomorrow's car is built a little differently.
 */
export function createSkin(name, file) {
  const texture = new THREE.Data3DTexture(new Uint8Array(4), 1, 1, 1);
  texture.format = THREE.RGBAFormat;
  texture.type = THREE.UnsignedByteType;
  // Nearest both ways: the look is pixels, and a linear filter would also blend a painted voxel's
  // colour with the bare one beside it — and bare is alpha 0, which reads as a mode, not a colour.
  texture.minFilter = THREE.NearestFilter;
  texture.magFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  texture.wrapS = texture.wrapT = texture.wrapR = THREE.ClampToEdgeWrapping;
  texture.unpackAlignment = 1;

  const uniforms = {
    tPaint: { value: texture },
    uPaintMin: { value: new THREE.Vector3() },
    uPaintSize: { value: new THREE.Vector3(1, 1, 1) },
    uPaintVoxel: { value: 1 },
  };

  const skin = {
    name,
    texture,
    uniforms,
    min: new THREE.Vector3(),
    dims: [1, 1, 1],
    voxel: 1,
    bytes: texture.image.data,
    /** The `data` string last written to disk, so the garage can ignore its own save echoing back. */
    saved: null,

    /** Replace the whole volume from a skin file's contents. */
    load(json) {
      if (json?.version !== SKIN_VERSION) throw new Error(`paint: ${name} skin version ${json?.version}`);
      const [nx, ny, nz] = json.dims;
      const bytes = new Uint8Array(nx * ny * nz * 4);
      decodeVolume(json.data, bytes);
      skin.dims = [nx, ny, nz];
      skin.voxel = json.voxel;
      skin.min.fromArray(json.min);
      skin.bytes = bytes;
      texture.image = { data: bytes, width: nx, height: ny, depth: nz };
      uniforms.uPaintMin.value.copy(skin.min);
      uniforms.uPaintSize.value.set(nx * json.voxel, ny * json.voxel, nz * json.voxel);
      uniforms.uPaintVoxel.value = json.voxel;
      skin.saved = json.data;
      skin.touch();
    },

    /** The current volume as a skin file. */
    toJSON() {
      return {
        version: SKIN_VERSION,
        min: skin.min.toArray(),
        voxel: skin.voxel,
        dims: [...skin.dims],
        data: encodeVolume(skin.bytes),
      };
    },

    /** Re-upload after the bytes changed. */
    touch() { texture.needsUpdate = true; },

    /** Cell coordinates of a local point, unclamped (may fall outside). */
    cellOf(p, out = [0, 0, 0]) {
      out[0] = Math.floor((p.x - skin.min.x) / skin.voxel);
      out[1] = Math.floor((p.y - skin.min.y) / skin.voxel);
      out[2] = Math.floor((p.z - skin.min.z) / skin.voxel);
      return out;
    },

    /** Byte offset of cell (i, j, k), or -1 outside the volume. Layout matches the 3D texture. */
    offset(i, j, k) {
      const [nx, ny, nz] = skin.dims;
      if (i < 0 || j < 0 || k < 0 || i >= nx || j >= ny || k >= nz) return -1;
      return ((k * ny + j) * nx + i) * 4;
    },

    /**
     * Where the shader samples for a surface point `p` with outward normal `n`: a quarter voxel
     * inside it. See SURFACE_SINK.
     */
    surfacePoint(p, n, out = new THREE.Vector3()) {
      return out.copy(p).addScaledVector(n, -SURFACE_SINK * skin.voxel);
    },

    /** [r, g, b, mode] at a local point — what the shader would read there — or null outside. */
    sample(p) {
      const [i, j, k] = skin.cellOf(p);
      const at = skin.offset(i, j, k);
      if (at < 0) return null;
      return [skin.bytes[at], skin.bytes[at + 1], skin.bytes[at + 2], skin.bytes[at + 3]];
    },

    /** How many voxels carry paint. */
    painted() {
      let n = 0;
      for (let a = 3; a < skin.bytes.length; a += 4) if (skin.bytes[a] !== PAINT_NONE) n++;
      return n;
    },
  };

  skin.load(file);
  return skin;
}

/**
 * Paint (or with `mode` PAINT_NONE, erase) every voxel whose centre lies within `radius` local
 * units of `centre`. `rgb` is sRGB bytes — what a colour picker hands over; the shader linearises.
 * Returns how many voxels changed.
 */
export function paintSphere(skin, centre, radius, rgb, mode) {
  // The cell `centre` is in always takes the paint, however small the brush: a radius under a
  // voxel's half-diagonal can otherwise miss every cell centre and paint nothing.
  radius = Math.max(radius, 0);
  const v = skin.voxel;
  const r2 = radius * radius;
  const lo = skin.cellOf({ x: centre.x - radius, y: centre.y - radius, z: centre.z - radius });
  const hi = skin.cellOf({ x: centre.x + radius, y: centre.y + radius, z: centre.z + radius });
  const home = skin.cellOf(centre);
  const bytes = skin.bytes;
  const erase = mode === PAINT_NONE;
  let changed = 0;
  for (let k = lo[2]; k <= hi[2]; k++) {
    const dz = skin.min.z + (k + 0.5) * v - centre.z;
    for (let j = lo[1]; j <= hi[1]; j++) {
      const dy = skin.min.y + (j + 0.5) * v - centre.y;
      for (let i = lo[0]; i <= hi[0]; i++) {
        const dx = skin.min.x + (i + 0.5) * v - centre.x;
        const own = i === home[0] && j === home[1] && k === home[2];
        if (!own && dx * dx + dy * dy + dz * dz > r2) continue;
        const at = skin.offset(i, j, k);
        if (at < 0) continue;
        const r = erase ? 0 : rgb[0];
        const g = erase ? 0 : rgb[1];
        const b = erase ? 0 : rgb[2];
        if (bytes[at] === r && bytes[at + 1] === g && bytes[at + 2] === b && bytes[at + 3] === mode) continue;
        bytes[at] = r; bytes[at + 1] = g; bytes[at + 2] = b; bytes[at + 3] = mode;
        changed++;
      }
    }
  }
  if (changed) skin.touch();
  return changed;
}

// --- Geometry -----------------------------------------------------------------------------------

/**
 * Give `geometry` the `paintPos` attribute the shader samples by: its own positions, moved by
 * `offset` — the translation from the mesh's frame to the vehicle's at rest (a door's hinge, a
 * wheel's anchor). Only translations, because every hinge in this project is shut at rotation 0;
 * `tools/garage.mjs` checks that claim against the live transforms rather than trusting it.
 */
export function stampPaintPos(geometry, offset = null) {
  const src = geometry.attributes.position.array;
  const out = new Float32Array(src.length);
  const ox = offset?.x ?? 0;
  const oy = offset?.y ?? 0;
  const oz = offset?.z ?? 0;
  for (let i = 0; i < src.length; i += 3) {
    out[i] = src[i] + ox;
    out[i + 1] = src[i + 1] + oy;
    out[i + 2] = src[i + 2] + oz;
  }
  geometry.setAttribute('paintPos', new THREE.BufferAttribute(out, 3));
  return geometry;
}

// --- The shader patch ---------------------------------------------------------------------------

/** Every replace asserts its match: a no-op patch draws an unpainted car and says nothing. */
function inject(source, anchor, text, where) {
  if (!source.includes(anchor)) throw new Error(`paint: ${where} has no ${anchor}`);
  return source.replace(anchor, text);
}

/**
 * Patch a compiling `propMaterial` shader to read paint. Called from inside `patchProp`'s own
 * `onBeforeCompile` (util/geo.js), which owns the cache key: the source is identical for every
 * skin, so every painted material shares one program and only the uniforms differ.
 *
 * Applied after `<color_fragment>`, which is where the vertex colour has just been multiplied in.
 * The paint *replaces* the vertex colour there and keeps the material colour — `diffuse` — so the
 * wreck's scorch (a multiply on `material.color`, game/wreckage.js) and the highlight's emissive
 * lift both still reach a painted panel. Everything downstream — lighting, AO, Crayon and Cartoon —
 * sees an ordinary diffuse colour and needs no idea paint exists.
 */
export function patchPaintShader(shader, skin) {
  Object.assign(shader.uniforms, skin.uniforms);
  shader.vertexShader = inject(shader.vertexShader, '#include <common>', `#include <common>
attribute vec3 paintPos;
uniform float uPaintVoxel;
varying vec3 vPaintPos;
varying vec3 vPaintTint;`, 'vertex shader');
  shader.vertexShader = inject(shader.vertexShader, '#include <color_vertex>', `#include <color_vertex>
	// Rest frames are translations only (stampPaintPos), so the object normal is already in the
	// skin's orientation. Sunk a quarter voxel in: see SURFACE_SINK in util/paint.js.
	vPaintPos = paintPos - normalize( normal ) * ( ${SURFACE_SINK} * uPaintVoxel );
	vPaintTint = vec3( 1.0 );
#ifdef USE_INSTANCING_COLOR
	vPaintTint = instanceColor.rgb;
#endif`, 'vertex shader');

  // No backticks in here: this is a template literal (see CLAUDE.md).
  shader.fragmentShader = inject(shader.fragmentShader, '#include <common>', `#include <common>
uniform highp sampler3D tPaint;
uniform vec3 uPaintMin;
uniform vec3 uPaintSize;
varying vec3 vPaintPos;
varying vec3 vPaintTint;
vec3 paintLinear( vec3 c ) {
	return mix( c / 12.92, pow( ( c + 0.055 ) / 1.055, vec3( 2.4 ) ), step( 0.04045, c ) );
}`, 'fragment shader');
  shader.fragmentShader = inject(shader.fragmentShader, '#include <color_fragment>', `#include <color_fragment>
	{
		// Alpha is the mode: under 0.25 bare, over 0.75 fixed, between them tinted by the instance.
		vec4 paint = texture( tPaint, ( vPaintPos - uPaintMin ) / uPaintSize );
		if ( paint.a > 0.25 ) {
			vec3 ink = paintLinear( paint.rgb );
			if ( paint.a < 0.75 ) ink *= vPaintTint;
			diffuseColor.rgb = diffuse * ink;
		}
	}`, 'fragment shader');
}
