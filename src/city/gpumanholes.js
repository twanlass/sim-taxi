/**
 * The manhole covers' metal under WebGPURenderer: `patchCover` (city/manholes.js) as nodes. Every
 * number and the reasoning for it is beside the GLSL; this is the same arithmetic at the prop
 * node material's seams (util/gpumaterial.js):
 *
 * - `surfaces`, a multiply on the diffuse colour, carries the albedo: worn iron on the lid, the
 *   frame's own colour, the dark seam. The frame *replaces* the lid's colour in the GLSL, and a
 *   multiply can say that only because every vertex of the mesh wears the one lid colour.
 * - `normalNode` is the bent normal off the cast surface's height.
 * - `lightingFactory` adds the Blinn glint inside the light loop, where the light's colour already
 *   has its shadow in it. A node material sums the specular it is handed, so the GLSL's last
 *   patch (Lambert never adds its specular) has nothing to port.
 */
import {
  abs, attribute, cameraWorldMatrix, clamp, dot, float, fract, fwidth, length, max, mix, normalize,
  normalView, positionViewDirection, pow, smoothstep, transformDirection, uniform, varying, vec2, vec3,
} from 'three/tsl';

export function coverNodes(material, { lid, uniforms }) {
  const frameColor = uniform(uniforms.uCoverFrame.value);
  const glint = uniform(0).onRenderUpdate(() => uniforms.uCoverGlint.value);
  const shine = uniform(0).onRenderUpdate(() => uniforms.uCoverShine.value);
  const p = varying(attribute('aCover', 'vec2'));
  const band01 = (a, b, x) => smoothstep(a, b, x);

  // coverHeight: the cast surface at q (unit radius), the tread scaled by detail.
  const height = (q, detail) => {
    const r = length(q);
    const frame = band01(0.80, 0.83, r).mul(float(1).sub(band01(0.93, 1.0, r)));
    const seam = band01(0.76, 0.79, r).mul(float(1).sub(band01(0.79, 0.82, r)));
    // The GLSL's mat2 is column-major: a quarter turn of the grid, then 0.13 units a diamond.
    const t = vec2(q.x.sub(q.y), q.x.add(q.y)).mul(0.7071 / 0.13);
    const f = abs(fract(t).sub(0.5));
    const stud = float(1).sub(band01(0.22, 0.32, max(f.x, f.y)));
    const band = band01(0.42, 0.45, r).mul(float(1).sub(band01(0.52, 0.55, r)));
    const lidHeight = float(1).sub(band01(0.74, 0.77, r))
      .mul(max(band, stud.mul(detail).mul(float(1).sub(band)).mul(0.6).add(float(1).sub(detail).mul(0.2))));
    return frame.add(lidHeight).sub(seam.mul(0.5));
  };

  const r = length(p);
  // How many cover-units a pixel spans: the tread is gone by the time a diamond is ~2 pixels.
  const detail = float(1).sub(smoothstep(0.03, 0.09, fwidth(p.x).add(fwidth(p.y)))).toVar();
  const e = 0.012;
  const h0 = height(p, detail).toVar();
  const k = detail.mul(0.6).add(0.4).mul(0.05 / e);
  const frame = smoothstep(0.80, 0.83, r);
  const seam = smoothstep(0.76, 0.79, r).mul(float(1).sub(smoothstep(0.79, 0.82, r)));
  const worn = clamp(h0, 0, 1);

  material.surfaces = [...(material.surfaces ?? []), {
    key: 'manhole',
    paint: () => mix(vec3(mix(0.8, 1.25, worn)), frameColor.div(vec3(lid.r, lid.g, lid.b)), frame)
      .mul(float(1).sub(seam.mul(0.6))),
  }];
  // World to view. `transformDirection(v, m)` is `v * m`, the transpose's product: the camera's
  // *world* matrix is the one that takes a world direction into view space.
  material.normalNode = transformDirection(normalize(vec3(
    h0.sub(height(p.add(vec2(e, 0)), detail)).mul(k), 1.0, h0.sub(height(p.add(vec2(0, e)), detail)).mul(k),
  )), cameraWorldMatrix);
  const gloss = glint.mul(mix(worn.mul(0.6).add(0.6), 1.0, frame)).mul(float(1).sub(seam));
  material.lightingFactory = (Base) => class CoverLighting extends Base {
    direct(input, builder) {
      super.direct(input, builder);
      const { lightDirection, lightColor, reflectedLight } = input;
      const h = normalize(lightDirection.add(positionViewDirection));
      // The floor is for WGSL, where 0 to a power is not reliably 0.
      reflectedLight.directSpecular.addAssign(
        lightColor.mul(pow(clamp(dot(normalView, h), 1e-6, 1), shine)).mul(gloss));
    }
  };
  return material;
}
