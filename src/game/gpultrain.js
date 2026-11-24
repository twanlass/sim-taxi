/**
 * The L train's two shader patches for the WebGPU renderer (game/ltrain.js): the dither that
 * takes the deck off the island and thins it over what the player needs to see (`fadeMaterial`),
 * and the intro that raises the bents and sets the spans down (`introMaterial`). What each does
 * and why is beside the GLSL there; this is the same arithmetic, and reads the same uniform bags.
 *
 * Both end in a discard, so both are a term of the material's `maskNode`; the intro also moves
 * vertices, as `positionNode`, which three hands to the sun's shadow pass as well. That pass has
 * no discard: a span that has not been laid yet casts from where it waits, 1.6 units up, for the
 * 0.4 s of its fall. The city's entrance makes the same trade (game/cityentry.js).
 *
 * The nodes are made once and shared, so every deck, car and lamp is one build per material kind.
 */
import {
  abs, attribute, clamp, float, floor, length, max, min, mix, mod, positionLocal, positionWorld,
  screenCoordinate, smoothstep, step, uniform, varying, vec3,
} from 'three/tsl';

/**
 * The 4x4 ordered dither threshold in (0, 1) at this fragment: `lBayer` without its table. Entry
 * (x, y) of that table is the bits of x^y and y interleaved, high bit first: 8a0 + 4y0 + 2a1 + y1.
 * Rows count down the screen here and up it on WebGL, so the pattern is mirrored top to bottom.
 */
let bayer = null;
const dither = () => {
  if (!bayer) {
    const p = floor(screenCoordinate.xy);
    const x0 = mod(p.x, 2);
    const x1 = floor(mod(p.x, 4).div(2));
    const y0 = mod(p.y, 2);
    const y1 = floor(mod(p.y, 4).div(2));
    bayer = abs(x0.sub(y0)).mul(8).add(y0.mul(4)).add(abs(x1.sub(y1)).mul(2)).add(y1).add(0.5).div(16);
  }
  return bayer;
};
/** Kept where `amount` is 1, gone where it is 0, dithered between. */
const kept = (amount) => amount.greaterThanEqual(0.999).or(amount.greaterThanEqual(dither()));

const also = (material, term) => {
  material.maskNode = material.maskNode ? material.maskNode.and(term) : term;
  material.userData.ported = true;
};

let fade = null;
/** `bag`: FADE_UNIFORMS. Its vectors are read live, so `setFadePoints` goes on working. */
export function fadeNodesOn(material, bag) {
  if (!fade) {
    const coast = uniform(bag.uLCoast.value);
    const band = uniform(bag.uLCoastBand.value);
    const radius = uniform(bag.uLRadius.value);
    const at = positionWorld;
    const past = max(max(at.x.negate().sub(coast.x), at.x.sub(coast.y)),
      max(at.z.negate().sub(coast.z), at.z.sub(coast.w)));
    const edge = clamp(past.div(band), 0, 1);
    let keep = float(1).sub(edge.mul(edge).mul(float(3).sub(edge.mul(2))));
    // One uniform a slot rather than an array: three makes an array uniform per build, and the
    // vectors are mutated in place, which a plain uniform follows.
    for (const point of bag.uLFade.value) {
      const s = uniform(point);
      const f = float(1).sub(smoothstep(radius.x, radius.y, length(at.xz.sub(s.xy))));
      keep = min(keep, mix(1, radius.z, f.mul(s.z)));
    }
    fade = kept(keep);
  }
  also(material, fade);
}

let intro = null;
/** `bag`: INTRO_UNIFORMS. `K`: the constants the GLSL inlines. */
export function introNodesOn(material, bag, K) {
  if (!intro) {
    const live = (slot) => uniform(slot.value).onRenderUpdate(() => slot.value);
    const time = live(bag.uLIntroT);
    const over = live(bag.uLOver);
    const a = attribute('aLIntro', 'vec4');
    const drop = step(1.5, a.y);
    const rise = step(0.5, a.y).mul(float(1).sub(drop));

    // A span: set down from dropH above, easing out, dithering in over the first part of the fall.
    const tDrop = clamp(time.sub(a.x).div(K.dropDur), 0, 1);
    const d = float(1).sub(tDrop);
    const dropped = positionLocal.add(vec3(0, d.mul(d).mul(d).mul(K.dropH), 0));

    // A bent: the city entry's rise, about its own foot. a.zw is where that foot stands.
    const tRise = clamp(time.sub(a.x).div(live(bag.uLGrow)), 0, 1);
    const b = tRise.sub(1);
    const s = float(1).add(over.add(1).mul(b).mul(b).mul(b)).add(over.mul(b).mul(b));
    const xz = mix(K.riseXZFrom, 1, s);
    const risen = vec3(
      a.z.add(positionLocal.x.sub(a.z).mul(xz)),
      positionLocal.y.sub(K.kerbH).mul(s).add(K.kerbH),
      a.w.add(positionLocal.z.sub(a.w).mul(xz)),
    );

    const shown = varying(mix(mix(1, smoothstep(0, K.riseFade, tRise), rise), smoothstep(0, 0.6, tDrop), drop));
    intro = {
      position: mix(mix(positionLocal, risen, rise), dropped, drop),
      mask: kept(shown),
    };
  }
  material.positionNode = intro.position;
  also(material, intro.mask);
}
