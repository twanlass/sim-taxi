/**
 * The one water shader, for the WebGPU renderer: `riverwater.js`'s GLSL as TSL nodes.
 *
 * riverwater.js is still where the water is *designed*: what each constant is, why the reflection
 * is traced against the channel rather than sampled, why the bed shelves. This file is the same
 * arithmetic in the other shading language, kept line for line against that one so the two can be
 * read side by side. The seams are the node material's equivalents of the three GLSL hooks:
 *
 *   `<normal_fragment_maps>`  ->  `material.normalNode` (the rippled normal, lit by three)
 *   `RE_Direct`               ->  the lighting model's `direct` (the sun's glint, the caustic's sun)
 *   `<opaque_fragment>`       ->  the lighting model's `finish` (refraction, bed, reflection, rim)
 *
 * Only the smooth surface is here. `?water=classic`'s faceted one stays a WebGL look until
 * someone asks for it.
 *
 * Two things WGSL makes the port do differently, both in `reflectChannel`:
 *   - a screen-space derivative has to be taken in uniform control flow, so the rail's `fwidth`
 *     sits at the top of the function and the "open sea, just sky" case is a select at the end
 *     rather than an early return;
 *   - there are no uniform arrays of structs worth the trouble for three bridges, so the loop is
 *     unrolled in JavaScript.
 */
import {
  Fn, If, abs, atan, clamp, cos, cross, diffuseColor, dot, exp, float, floor, fract, fwidth, int, length,
  max, min, mix, normalize, positionViewDirection, positionWorld, pow, reflect, refract, select, sin,
  smoothstep, step, transformNormalToView, uniform, vec2, vec3, vec4, cameraWorldMatrix, cameraViewMatrix,
} from 'three/tsl';

const PI = Math.PI;

// The sun and the fill, for the surfaces the water *reflects*: lit by hand, unshadowed, as
// `waterLit` does from three's light uniforms. game/scene.js hands them in.
const lights = { sun: null, hemi: null };
export function bindWaterLights(sun, hemi) {
  lights.sun = sun;
  lights.hemi = hemi;
}

export function createWaterNodes(U, K) {
  const time = uniform(0).onRenderUpdate(() => U.uWaterTime.value);
  const sky = uniform(U.uWaterSky.value);
  const wallC = uniform(U.uWaterWall.value);
  const grimeC = uniform(U.uWaterGrime.value);
  const trim = uniform(U.uWaterTrim.value);
  const soffit = uniform(U.uWaterSoffit.value);
  const bed = uniform(U.uWaterBed.value);
  const quay = uniform(U.uWaterQuay.value);
  const edges = uniform(U.uWaterEdges.value);
  const banks = uniform(U.uWaterBanks.value);
  const sea = uniform(U.uWaterSea.value);
  const basin = uniform(U.uWaterBasin.value);
  const shore = uniform(0).onRenderUpdate(() => U.uWaterShore.value);
  const bridges = U.uWaterBridges.value.map((v) => uniform(v));

  const sunColor = uniform(vec3(0)).onRenderUpdate((_, self) => {
    const { sun } = lights;
    if (sun) self.value.set(sun.color.r, sun.color.g, sun.color.b).multiplyScalar(sun.visible ? sun.intensity : 0);
  });
  const sunDir = uniform(vec3(0, 1, 0)).onRenderUpdate((_, self) => {
    const { sun } = lights;
    if (sun) self.value.copy(sun.position).sub(sun.target.position).normalize();
  });
  const hemiSky = uniform(vec3(0)).onRenderUpdate((_, self) => {
    const { hemi } = lights;
    if (hemi) self.value.set(hemi.color.r, hemi.color.g, hemi.color.b).multiplyScalar(hemi.intensity);
  });
  const hemiGround = uniform(vec3(0)).onRenderUpdate((_, self) => {
    const { hemi } = lights;
    if (hemi) self.value.set(hemi.groundColor.r, hemi.groundColor.g, hemi.groundColor.b).multiplyScalar(hemi.intensity);
  });

  const hash2 = Fn(([c]) => fract(sin(vec2(dot(c, vec2(127.1, 311.7)), dot(c, vec2(269.5, 183.3)))).mul(43758.5453)));

  // waterSmooth: the analytic normal of the swell plus a finer set of ripples.
  const smooth = Fn(([p, amp]) => {
    const wave = (kx, kz, w, a, sign = -1) => cos(dot(p, vec2(kx, kz)).add(time.mul(w * sign))).mul(a).mul(vec2(kx, kz));
    const g = wave(0.78, 0.22, 1.25, 0.50).add(wave(0.52, -0.98, 1.65, 0.35))
      .add(wave(-0.64, 0.92, 1.05, 0.30, 1)).add(wave(1.55, 0.58, 2.2, 0.20));
    const d = wave(2.1, 0.9, 2.6, 0.50).add(wave(-1.3, 2.3, 2.9, 0.40))
      .add(wave(2.7, -1.6, 3.4, 0.30)).add(wave(0.6, 3.1, 2.3, 0.25, 1));
    const slope = g.add(d.mul(K.SMOOTH_DETAIL)).mul(amp);
    return normalize(vec3(slope.x.negate(), 1, slope.y.negate()));
  });

  const caustic = Fn(([p]) => {
    const t = time.mul(0.7);
    const q = p.mul(0.95);
    const c = sin(q.x.mul(2.1).add(sin(q.y.mul(1.7).add(t)).mul(1.3)).add(t.mul(0.6)))
      .add(sin(q.y.mul(2.4).add(sin(q.x.mul(1.9).sub(t.mul(1.1))).mul(1.2)).sub(t.mul(0.4))));
    return float(1).sub(abs(c.mul(0.5))).pow(6);
  });

  // waterLit, in world space: `n` is a constant axis, so this is two dot products.
  const lit = (albedo, n) => {
    const irr = mix(hemiGround, hemiSky, n[1] * 0.5 + 0.5)
      .add(sunColor.mul(clamp(dot(vec3(...n), sunDir), 0, 1)));
    return albedo.mul(irr).div(PI);
  };

  const wallAt = (x) => select(sea.y.greaterThan(0), step(x, sea.x), float(1));

  // waterBasinHit. `best` is a variable and is narrowed in place, as the GLSL's `inout` is.
  const basinHit = (p, d, best) => {
    const face = int(0).toVar();
    If(sea.y.greaterThan(0), () => {
      If(p.x.greaterThan(sea.x).and(d.x.lessThan(0)), () => {
        const sb = p.x.sub(sea.x).div(d.x.negate());
        const zb = p.z.add(d.z.mul(sb));
        If(sb.lessThan(best).and(zb.greaterThan(basin.x)).and(zb.lessThan(basin.y))
          .and(zb.lessThan(edges.x).or(zb.greaterThan(edges.y))), () => {
          best.assign(sb);
          face.assign(1);
        });
      });
      If(p.z.greaterThan(basin.x).and(d.z.lessThan(0)), () => {
        const sq = p.z.sub(basin.x).div(d.z.negate());
        const xq = p.x.add(d.x.mul(sq));
        If(sq.lessThan(best).and(xq.greaterThan(sea.x)).and(xq.lessThan(basin.z)), () => {
          best.assign(sq);
          face.assign(2);
        });
      });
    });
    return face;
  };

  // waterEdgeDist: how far a point on the surface is from the nearest thing it laps against.
  const edgeDist = Fn(([p]) => {
    const d = min(p.y.sub(edges.x), edges.y.sub(p.y)).toVar();
    const out = float(0).toVar();
    const atSea = sea.y.greaterThan(0);
    If(atSea.and(p.x.lessThanEqual(sea.x)).and(d.lessThan(0)), () => {
      out.assign(1e3);
    }).ElseIf(atSea.and(p.x.greaterThan(sea.x)), () => {
      If(p.y.lessThan(basin.x).or(p.y.greaterThan(basin.y)), () => {
        out.assign(1e3);
      }).Else(() => {
        d.assign(select(p.y.greaterThan(edges.x).and(p.y.lessThan(edges.y)),
          min(length(p.sub(vec2(sea.x, edges.x))), length(p.sub(vec2(sea.x, edges.y)))),
          p.x.sub(sea.x)));
        If(p.x.lessThan(basin.z), () => {
          d.assign(min(d, min(p.y.sub(basin.x), basin.y.sub(p.y))));
        });
        out.assign(max(d, 0));
      });
    }).Else(() => {
      out.assign(max(d, 0));
    });
    return out;
  });

  const deck = (z, rise) => {
    const u = clamp(z.sub(banks.x).div(banks.y.sub(banks.x)), 0, 1);
    const s = sin(u.mul(PI));
    return rise.mul(s).mul(s);
  };

  // waterReflect: what the mirrored ray meets. The near wall and its railing, the harbour's
  // quays, then each bridge's fascia or soffit, and the sky behind all of it.
  const reflectChannel = Fn(([p, r]) => {
    const best = p.z.sub(edges.x).div(max(r.z.negate(), 1e-3)).toVar();
    const wallHere = select(best.greaterThan(0), wallAt(p.x.add(r.x.mul(best))), float(0)).toVar();
    If(wallHere.lessThanEqual(0), () => { best.assign(1e6); });
    const face = basinHit(p, r, best);
    If(face.greaterThan(0), () => { wallHere.assign(1); });
    const y = p.y.add(r.y.mul(best));
    // The tide mark, on the walls' own curve (grimeAt, city/grime.js).
    const grimeT = float(1).sub(clamp(y.sub(K.WATER_Y).div(K.GRIME_RISE), 0, 1));
    const grimeW = grimeT.mul(grimeT).mul(K.GRIME_DEPTH);
    const wallG = mix(wallC, grimeC, grimeW);
    const quayG = mix(quay, grimeC, grimeW);
    const wall = select(face.equal(0), lit(wallG, [0, 0, 1]),
      select(face.equal(1), lit(quayG, [1, 0, 0]), lit(quayG, [0, 0, 1])));
    const col = mix(wall, sky, smoothstep(K.KERB_H - K.EDGE_SOFT, K.KERB_H + K.EDGE_SOFT, y)).toVar();
    const up = y.sub(K.KERB_H);
    const aa = max(fwidth(up), 1e-4);
    const rail = float(1).sub(smoothstep(aa.negate().add(K.RAIL_W), aa.add(K.RAIL_W), abs(up.sub(K.RAIL_H - K.RAIL_W / 2))))
      .add(float(1).sub(smoothstep(aa.negate().add(K.RAIL_W * 0.7), aa.add(K.RAIL_W * 0.7), abs(up.sub(K.RAIL_H * 0.5)))));
    col.assign(mix(col, wall, select(face.equal(0), clamp(rail, 0, 1).mul(0.6), float(0))));
    col.assign(mix(sky, col, wallHere));
    for (const b of bridges) {
      If(b.w.greaterThan(0), () => {
        const sIn = max(0, p.x.sub(b.y).div(r.x.negate()));
        const sOut = min(p.x.sub(b.x).div(r.x.negate()), best);
        If(sOut.greaterThan(sIn), () => {
          const yIn = p.y.add(r.y.mul(sIn));
          const top = deck(p.z.add(r.z.mul(sIn)), b.z);
          If(yIn.greaterThanEqual(top.sub(K.DECK_THICK)).and(yIn.lessThanEqual(top.add(K.KERB_H))), () => {
            col.assign(mix(col, lit(trim, [1, 0, 0]), b.w));
            best.assign(sIn);
          }).ElseIf(yIn.lessThan(top.sub(K.DECK_THICK)), () => {
            const yOut = p.y.add(r.y.mul(sOut));
            If(yOut.greaterThanEqual(deck(p.z.add(r.z.mul(sOut)), b.z).sub(K.DECK_THICK)), () => {
              col.assign(mix(col, lit(soffit, [0, -1, 0]), b.w));
              best.assign(sIn);
            });
          });
        });
      });
    }
    // Past the shore there is no channel to reflect: the open sea mirrors the sky.
    return select(p.z.greaterThan(shore), sky, col);
  });

  // The direction to the camera, in world space: the view matrix's third row.
  const toCamera = normalize(cameraWorldMatrix.mul(vec4(0, 0, 1, 0)).xyz);
  const upView = normalize(cameraViewMatrix.mul(vec4(0, 1, 0, 0)).xyz);

  return {
    sky, bed, wallC, grimeC, quay, edges, sea, shore, hash2, smooth, caustic, edgeDist, reflectChannel,
    basinHit, wallAt, toCamera, upView,
  };
}

/**
 * Dress a `propMaterial()` node material as water.
 *
 * @param kind  'river' for the channel and the sea (reflects the channel, wets with height), or a
 *              still body: `{ edge(world, N), tune }`, which reflects only sky.
 */
export function waterNodeMaterial(material, N, K, still = null) {
  const world = positionWorld;
  const wet = still ? float(1) : clamp(world.y.div(K.WATER_Y), 0, 1).pow(3);
  const waterN = N.smooth(world.xz, wet.mul(K.SMOOTH_AMP)).toVar();
  material.normalNode = transformNormalToView(waterN);

  material.lightingFactory = (Base) => class WaterLighting extends Base {
    start(builder) {
      this.spec = vec3(0).toVar();
      this.sun = vec3(0).toVar();
      super.start(builder);
    }

    // RE_Direct_Water: the Lambert term as it was, plus the glint and how much sun is overhead.
    direct(input, builder) {
      super.direct(input, builder);
      const { lightDirection, lightColor } = input;
      const h = normalize(lightDirection.add(positionViewDirection));
      this.spec.addAssign(lightColor.mul(pow(clamp(dot(material.normalNode, h), 0, 1), K.SHINE)));
      this.sun.addAssign(lightColor.mul(clamp(dot(N.upView, lightDirection), 0, 1)));
    }

    finish(input) {
      super.finish(input);
      const { outgoingLight } = input.context;
      const V = N.toCamera;
      const rd = refract(V.negate(), waterN, 0.7518797);
      const irr = outgoingLight.div(max(diffuseColor.rgb, vec3(0.02)));
      const fresnel = (cosT) => float(K.F0).add(float(1).sub(cosT).pow(5).mul(1 - K.F0));
      const cosT = clamp(dot(waterN, V), 0, 1);

      if (still) {
        const { tune } = still;
        const edge = still.edge(world);
        const depth = mix(tune.bedEdge, tune.bedMid, smoothstep(0, tune.shelf, edge));
        const s = depth.div(max(rd.y.negate(), 1e-3));
        const seen = world.add(rd.mul(s));
        const under = N.bed.mul(N.hash2(floor(seen.xz.mul(1.3))).x.mul(0.5).add(0.75))
          .mul(irr.add(this.sun.mul(K.CAUSTIC / PI).mul(N.caustic(seen.xz))));
        const body = mix(outgoingLight, under, exp(vec3(...K.ABSORB).negate().mul(s)));
        const fres = max(
          fresnel(cosT).mul(1 - K.REFLECT_FLOOR).add(K.REFLECT_FLOOR).mul(tune.reflect),
          float(1).sub(smoothstep(0, tune.rim, edge)).mul(K.RIM_REFLECT),
        );
        outgoingLight.assign(mix(body, N.sky, fres).add(this.spec.mul(K.GLINT))
          .add(N.sky.mul(tune.glow).mul(float(1).sub(smoothstep(0, tune.glowW, edge)))));
        return;
      }

      const { edges, sea, shore } = N;
      const across = clamp(world.z.sub(edges.x).div(edges.y.sub(edges.x)), 0, 1);
      const seaward = max(
        select(sea.y.greaterThan(0), smoothstep(sea.x.sub(K.SEA_RUN_IN), sea.x, world.x), float(0)),
        step(shore, world.z),
      );
      const depth = mix(mix(K.BED_EDGE, K.BED_MID, sin(across.mul(PI))), K.SEA_BED, seaward).mul(wet);
      const sBed = depth.div(max(rd.y.negate(), 1e-3));
      const sWall = select(rd.z.lessThan(0).and(world.z.greaterThan(edges.x)).and(world.z.lessThan(shore)),
        world.z.sub(edges.x).div(rd.z.negate()), float(1e6)).toVar();
      If(N.wallAt(world.x.add(rd.x.mul(sWall))).lessThan(0.5), () => { sWall.assign(1e6); });
      const sunk = N.basinHit(world, rd, sWall);
      const s = min(sBed, sWall);
      const seen = world.add(rd.mul(s));
      const under = select(sWall.lessThan(sBed),
        mix(select(sunk.equal(0), N.wallC, N.quay), N.grimeC, K.GRIME_DEPTH).mul(step(0.5, fract(seen.y.mul(1.6))).mul(0.18).add(0.82)),
        N.bed.mul(N.hash2(floor(seen.xz.mul(1.3))).x.mul(0.5).add(0.75)))
        .mul(irr.add(this.sun.mul(K.CAUSTIC / PI).mul(N.caustic(seen.xz))));
      const body = mix(outgoingLight, under, exp(vec3(...K.ABSORB).negate().mul(s)));

      const refl = N.reflectChannel(world, reflect(V.negate(), waterN));
      const edge = N.edgeDist(world.xz);
      const fres = max(
        fresnel(cosT).mul(1 - K.REFLECT_FLOOR).add(K.REFLECT_FLOOR),
        float(1).sub(smoothstep(0, K.RIM_W, edge)).mul(K.RIM_REFLECT),
      );
      const water = mix(body, refl, fres).add(this.spec.mul(K.GLINT))
        .add(N.sky.mul(K.RIM_GLOW).mul(float(1).sub(smoothstep(0, K.RIM_GLOW_W, edge))));
      outgoingLight.assign(mix(outgoingLight, water, wet));
    }
  };
  material.userData.unported = (material.userData.unported ?? []).filter((what) => what !== 'water');
  return material;
}

/** The duck pond's outline: a lobed circle, measured inward from its bank. */
export const pondEdgeNode = (pond) => (world) => {
  const [l2, l3] = pond.lobes;
  const off = world.xz.sub(vec2(pond.x, pond.z));
  const ang = atan(off.y, off.x);
  const f = float(1).sub(sin(ang.mul(2).add(l2.phase)).add(1).mul(0.5 * l2.amp))
    .sub(sin(ang.mul(3).add(l3.phase)).add(1).mul(0.5 * l3.amp));
  return max(f.mul(pond.r).sub(pond.bank).sub(length(off)), 0);
};

/** The north park's lake: a lobed ellipse. */
export const lakeEdgeNode = (lake) => (world) => {
  const off = world.xz.sub(vec2(lake.x, lake.z));
  const n = off.div(vec2(lake.rx, lake.rz));
  const ang = atan(n.y, n.x);
  const k = float(1).add(sin(ang.mul(2).add(lake.p2)).mul(lake.l2)).add(sin(ang.mul(3).add(lake.p3)).mul(lake.l3));
  const t = max(length(n), 1e-4);
  return max(length(off).mul(k.div(t).sub(1)), 0);
};
