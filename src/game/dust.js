import * as THREE from 'three';
import { color } from '../palette.js';
import { carrySpeed } from '../util/carry.js';

// Dust kicked up behind the taxi in crazy mode — and, off the same pool, the wall of it a
// barricade throws, the collar of smoke that rings a wreck, and the rotor wash a helicopter lifts
// off a rooftop helipad eleven storeys up.
//
// Squashed low-poly spheres rather than camera-facing quads. A billboard is cheaper, but the puffs
// sat in the same plane as the road and read as flat stickers next to the faceted cars; a lit
// icosahedron picks up the same sun and shows the same hard facets as everything else in the city.
//
// One InstancedMesh, one draw call, a ring buffer of slots. Per-puff alpha needs a custom
// attribute — `instanceColor` is RGB only — so a small shader patch multiplies it in at the end.

// 200 rather than the 140 it sat at, because the boost trail now costs twice what it did: it is a
// plume per rear tyre rather than one off the centreline (see `kickDust` in main.js). The trail
// spends a slot per wheel every 0.47 units travelled, so at the overdrive top of 22.95 u/s it is
// laying ~98 puffs a second and holding ~103 of them alive across LIFE — against 140 that left 37
// for everything else, and a smash costs 26 with another 14 for its landing. The trail was
// recycling the burst's own puffs out from under it before they had faded, which is exactly the
// failure the jump from 90 to 140 was made to fix.
//
// (140 was itself up from the original 90 for the same reason. The wreck collar's 24 still need no
// headroom of their own: the trail stops on the frame it is fired, because the taxi that was
// laying it down has just been destroyed.)
const MAX_PUFFS = 200;
const LIFE = 1.05;
const START_ALPHA = 0.62;
const START_SIZE = 0.5;
const END_SIZE = 2.3;
const SQUASH = 0.55;         // flattened, so a puff spreads over the road rather than balling up

// The wreck collar. One ring of smoke around *both* cars rather than a burst per car: the two
// fireballs are only a couple of units apart and already merge into one blast, so a collar each
// would have packed grey into the middle of the fire — the one place the fire is supposed to be.
//
// WRECK_RING is where the puffs start, measured against the fireball it has to sit outside:
// blast.js throws its puffs PUFF_REACH 2.8 and draws them at PUFF_SIZE 3.2 on a 0.5-radius
// icosahedron, so the flame front reads out to about 4 units. At 3 the collar is tucked against
// the core on the impact frame and is pushed clear of it by its own throw — which is the point,
// since a collar that starts already clear reads as a second, later event. It is allowed to
// overlap the flame at the peak because it is drawn under it (renderOrder 3 against blast.js's 6),
// so the fire always keeps its own pixels.
//
// WRECK_LINGER is measured against the fire rather than picked: blast.js gives a fireball puff
// PUFF_LIFE 0.95 × up to 1.4 = 1.33s, and a burst puff is already on LIFE × 1.5 = 1.58s, which is
// only a tenth of a second of daylight past the flame — and spent at an alpha of 0.04. At 1.5 the
// collar runs to 2.4s, so the last thing left on the road after a wreck is smoke rather than
// orange. That is the whole reason for the effect: fire is what happened, smoke is what is left.
//
// WRECK_START_SIZE is the other half of that argument. The trail's curve opens at START_SIZE 0.5
// and swells to 2.3, which is right for dust coming off a tyre and wrong for smoke: at the frame
// the fireball peaks the collar was still at 29% of its size, and two dozen small hard-edged lumps
// ringing a blast read as thrown rubble. Starting at 1.2 they arrive as clouds and still finish at
// the same size, so nothing about the late frames moves.
//
// WRECK_CARRY is the last of the set, and the one that stops the collar giving the game away. The
// rest of the wreck was taught to keep the taxi's momentum (see util/carry.js and the CARRY
// fractions in game/blast.js) and this was not, so the fire, the shards and both shells slid
// downfield out of a grey ring left standing on the impact point — which reads worse than nothing
// having moved at all, because now there is a stationary thing in frame to measure the moving ones
// against. The fraction is high against the fireball's 0.42 for one reason: these puffs are spent
// against this pool's own drag of 3.4, not CARRY_DRAG's 1.7, so the same fraction buys less than
// half the ground. At 0.5 of a 22.1 u/s impact the collar covers 3.2 units against the fireball's
// 4.5 — a little behind it, which is right for the thing that is meant to be trailing.
const WRECK_COUNT = 24;
const WRECK_POWER = 1.15;
const WRECK_RING = 3;
const WRECK_LINGER = 1.5;
const WRECK_START_SIZE = 1.2;
const WRECK_CARRY = 0.5;

// Where a puff starts, vertically, when nobody says otherwise: just off the road, which is where
// all of this happens except the helicopter's and the landings. `add` takes a `y` for those — see
// game/chopper.js, and the landing burst in main.js, which adds this to the height of the bridge
// deck the taxi came down on — and everything else keeps the road it was written against.
//
// Exported for that second caller: a burst on a bridge is this much off the *deck*, and a caller
// that has to hard-code 0.3 to say so is a caller that will not follow this number when it moves.
export const DUST_ROAD_Y = 0.3;

export function createDust(scene, camera, rng) {
  // Detail 0: twenty faces. Enough to read as round at play zoom, few enough that the facets show.
  const geometry = new THREE.IcosahedronGeometry(0.5, 0);

  const alphas = new Float32Array(MAX_PUFFS);
  geometry.setAttribute('aAlpha', new THREE.InstancedBufferAttribute(alphas, 1));

  const material = new THREE.MeshLambertMaterial({
    // Pure white. The off-white it started as was already being warmed by the golden-hour sun,
    // which landed it close enough to the road's own tan that the puffs stopped reading as dust.
    // Per-puff tint rides `instanceColor` on top of this, so white is also the multiply identity.
    color: '#FFFFFF',
    flatShading: true,
    transparent: true,
    depthWrite: false,
  });

  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aAlpha;\nvarying float vAlpha;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n\tvAlpha = aAlpha;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vAlpha;')
      .replace('#include <dithering_fragment>', '#include <dithering_fragment>\n\tgl_FragColor.a *= vAlpha;');
  };

  const mesh = new THREE.InstancedMesh(geometry, material, MAX_PUFFS);
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.renderOrder = 3;      // above the rubber, below the cars and the game markers
  mesh.frustumCulled = false;
  scene.add(mesh);

  const life = new Float32Array(MAX_PUFFS);
  // How long this puff was *given*, so `t` can be normalised against its own span. A burst lives
  // longer than a trail puff, and normalising both against the LIFE constant put the long ones at a
  // negative age: they started at a sixteenth of their size and above full opacity, then grew.
  const span = new Float32Array(MAX_PUFFS);
  const px = new Float32Array(MAX_PUFFS);
  const py = new Float32Array(MAX_PUFFS);
  const pz = new Float32Array(MAX_PUFFS);
  const vx = new Float32Array(MAX_PUFFS);
  const vy = new Float32Array(MAX_PUFFS);
  const vz = new Float32Array(MAX_PUFFS);
  const spin = new Float32Array(MAX_PUFFS);
  const tilt = new Float32Array(MAX_PUFFS);
  const wide = new Float32Array(MAX_PUFFS);   // per-puff aspect, so they aren't obvious clones
  // Per-puff multiplier on the whole size curve. `scale` used to be folded into `wide`, which is
  // the *x* aspect alone — so a puff asked to be two and a half times the size came out two and a
  // half times as wide and exactly as tall and deep as a boost puff. Seen from this camera, which
  // looks down at 3/4, that reads as a smear on the road rather than as a cloud coming off an
  // impact. It is why the burst kept being described as too small while its numbers said otherwise.
  const grow = new Float32Array(MAX_PUFFS);
  // Where on the size curve this puff *starts*, before `grow`. The trail begins at a point and
  // swells, which is right for something coming off a tyre; smoke around a wreck is already a
  // cloud on the frame it appears. Left at START_SIZE the collar was at 29% of its size while the
  // fireball was at its peak — twenty-four hard little faceted lumps ringing the blast, which read
  // as thrown rubble rather than as smoke, and only became smoke once the fire had gone out.
  const from = new Float32Array(MAX_PUFFS);
  // Air resistance, per puff, 1/s. Zero for the boost trail — those puffs are laid down and left,
  // and giving them drag shortens a trail that is already tuned. A burst wants it: dust thrown out
  // of an impact punches away from the point and then stops, and the stop is the half that reads
  // as an impact rather than as a plume.
  const drag = new Float32Array(MAX_PUFFS);

  const dummy = new THREE.Object3D();
  const tintColor = new THREE.Color();
  const WHITE = new THREE.Color('#FFFFFF');

  // Everything starts collapsed to nothing rather than sitting at the origin as a visible blob,
  // and white — `setColorAt` allocates `instanceColor` on its first call, which adds
  // USE_INSTANCING_COLOR to the material and recompiles it. Doing that lazily would put a shader
  // compile on the first frame of a boost; doing it here puts it with the rest of the build.
  for (let slot = 0; slot < MAX_PUFFS; slot++) {
    dummy.scale.setScalar(0);
    dummy.updateMatrix();
    mesh.setMatrixAt(slot, dummy.matrix);
    mesh.setColorAt(slot, WHITE);
  }
  mesh.instanceMatrix.needsUpdate = true;
  mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);

  let next = 0;
  let tinted = false;   // a colour changed this frame, so the buffer needs re-uploading

  /**
   * Puff up from a point, with a bit of scatter so the trail isn't a straight line of clones.
   *
   * `scale` multiplies the puff's size and how hard it is thrown, and `spread` how far from the
   * point it starts. Both default to the boost trail's own values, which is what every caller
   * outside the barricade wants.
   *
   * `tint` is written on **every** spawn, not only the tinted ones. The pool is a ring buffer, so
   * a slot the wreck collar painted grey comes back round to the boost trail — and a trail puff
   * that inherited it would be one grey puff in a white plume with nothing to explain it.
   *
   * `y` is the surface the puff comes off. It defaults to the road because everything that spends
   * this pool did, until a helicopter started landing on a roof.
   *
   * Returns the slot, so a caller that wants a different *shape* of throw — the burst below — can
   * overwrite the velocity it was given rather than needing a second spawn path.
   */
  function add(x, z, yaw, scale = 1, spread = 0.35, tint = null, y = DUST_ROAD_Y) {
    const slot = next;
    next = (next + 1) % MAX_PUFFS;
    mesh.setColorAt(slot, tint ? tintColor.set(tint) : WHITE);
    tinted = true;

    span[slot] = LIFE * (scale > 1 ? 1.5 : 1);
    life[slot] = span[slot];
    px[slot] = x + rng.jitter(spread);
    py[slot] = y;
    pz[slot] = z + rng.jitter(spread);

    // Drifts backwards from the car and rises.
    vx[slot] = (-Math.cos(yaw) * rng.range(0.6, 1.6) + rng.jitter(0.7)) * scale;
    vy[slot] = rng.range(0.7, 1.5) * scale;
    vz[slot] = (Math.sin(yaw) * rng.range(0.6, 1.6) + rng.jitter(0.7)) * scale;

    spin[slot] = rng.range(0, Math.PI * 2);
    tilt[slot] = rng.range(-1, 1);
    wide[slot] = rng.range(0.85, 1.3);
    grow[slot] = scale;
    from[slot] = START_SIZE;
    drag[slot] = 0;
    alphas[slot] = START_ALPHA;
    return slot;
  }

  /**
   * A wall of it, for going through a barricade.
   *
   * The smash used to be two ordinary trail puffs, which is what the taxi lays down every frame of
   * a boost — so the one moment in the run that is meant to read as an impact produced two frames'
   * worth of ordinary exhaust. It then became thirteen of them thrown wider, which was better and
   * still wrong for a reason the numbers hid: `scale` only ever reached the x aspect (see `grow`),
   * so the burst was thirteen *smears*, not thirteen bigger clouds.
   *
   * What it is now: twenty-six puffs, genuinely bigger in all three axes, thrown **radially out of
   * the impact point** rather than trailing off the back of the car — a ring that punches outward
   * and then stops against its own drag, which is the shape dust makes when something hits
   * something. The pool is 140 slots, so this costs under a fifth of it and the trail behind the
   * taxi survives intact.
   *
   * `power` scales the whole thing at once, so the landing can be the same event turned down
   * rather than a second set of hand-picked numbers that drift away from these.
   *
   * `opts.tint` paints the puffs (the wreck collar is this burst in smoke grey), `opts.ring`
   * starts each one that far out along its own bearing, so the burst opens as a collar around
   * something rather than as a cloud on top of it, `opts.linger` stretches how long they are
   * given — a barricade throws dust that settles, a wreck leaves smoke that hangs —
   * `opts.startSize` starts them partway up the size curve rather than at a point, `opts.y` is
   * the surface it all comes off, for the one caller whose surface is a roof, and `opts.carry` is
   * a speed in u/s added to every puff's throw along `yaw` — the momentum of whatever made the
   * impact, for a burst that happens to something that was moving.
   */
  function burst(x, z, yaw, count = 26, power = 1,
    { tint = null, ring = 0, linger = 1, startSize = START_SIZE, y = DUST_ROAD_Y, carry = 0 } = {}) {
    // `yaw` is a sim heading, so forward is (cos yaw, −sin yaw). Rolled once outside the loop: it
    // is the same vector for every puff, which is what makes the collar travel as one cloud.
    const carryX = Math.cos(yaw) * carry;
    const carryZ = -Math.sin(yaw) * carry;
    for (let n = 0; n < count; n++) {
      // The scatter on the *start* point is tied to the ring when there is one. At the barricade's
      // 1.35 × power it is nearly as wide as the wreck collar's own radius, which scatters half the
      // puffs back into the middle and fills in the hole the ring was opened for.
      const spread = ring > 0 ? ring * 0.35 : 1.35 * power;
      const slot = add(x, z, yaw + rng.jitter(1.4), rng.range(1.9, 3.1) * power, spread, tint, y);

      // Fanned around the circle by index rather than at random: 26 random bearings clump, and a
      // clump reads as a few big puffs in one place instead of as a wall going up. The jitter on
      // top is what stops the ring looking stamped.
      const bearing = (n / count) * Math.PI * 2 + rng.jitter(0.45);
      const out = rng.range(4.5, 10.5) * power;
      // Pushed out along the same bearing it is thrown down, so the hole in the middle survives
      // the throw instead of being filled by the far side of the ring crossing it. The radius is
      // rolled per puff rather than shared: at one fixed radius the collar is a torus, and once the
      // fire in the middle of it has gone out a torus reads as a smoke *ring* — a shape with a
      // deliberate hole in it — rather than as a cloud around a wreck.
      //
      // It is rolled only when there is a ring to roll it against, so the barricade's burst draws
      // from this generator exactly as many times as it did before the collar existed and comes
      // out of a given run seed looking the same.
      const start = ring > 0 ? ring * rng.range(0.55, 1.15) : 0;
      px[slot] += Math.cos(bearing) * start;
      pz[slot] += Math.sin(bearing) * start;
      vx[slot] = Math.cos(bearing) * out + carryX;
      vz[slot] = Math.sin(bearing) * out + carryZ;
      // Low against the outward throw. Dust off a road impact boils along the ground and lifts
      // late; thrown up as hard as it goes out, it climbs clear of the car and reads as a plume.
      vy[slot] = rng.range(1.6, 3.4) * power;
      drag[slot] = 3.4;
      span[slot] *= linger;
      life[slot] = span[slot];
      from[slot] = startSize;
    }
  }

  /**
   * The smoke around a wreck: the barricade's burst, tinted and opened out into a collar.
   *
   * The crash used to be fire and nothing else, and a fireball on its own is a bright shape that
   * appears and goes away again. What the construction zone has that it did not is a *skirt* —
   * something billowing at the edge of the impact after the impact itself is over — so the fire
   * keeps the middle and this rings it. Fired once for the pair of cars, at the point between
   * them, and drawn under the fireball (renderOrder 3 against blast.js's 6), so the collar can
   * never wash over the flame front it is meant to be behind.
   *
   * It outlives the fire by design — see WRECK_LINGER, and it travels with the rest of the wreck
   * by design too — see WRECK_CARRY. `speed` is how fast the taxi was going when it hit, in u/s;
   * left out, the collar stands on the impact point, which is what the passing lab wants.
   */
  function wreckSmoke(x, z, yaw = 0, speed = 0) {
    burst(x, z, yaw, WRECK_COUNT, WRECK_POWER, {
      tint: color('wreckSmoke'),
      ring: WRECK_RING,
      linger: WRECK_LINGER,
      startSize: WRECK_START_SIZE,
      carry: carrySpeed(speed) * WRECK_CARRY,
    });
  }

  function update(dt) {
    for (let slot = 0; slot < MAX_PUFFS; slot++) {
      if (life[slot] <= 0) continue;

      life[slot] -= dt;
      const t = 1 - Math.max(0, life[slot]) / span[slot];   // 0 fresh, 1 spent

      px[slot] += vx[slot] * dt;
      py[slot] += vy[slot] * dt;
      pz[slot] += vz[slot] * dt;
      vy[slot] -= 0.6 * dt;                            // settles back down as it spreads
      // Exponential rather than subtractive, so it is frame-rate independent and cannot push a
      // puff backwards through zero on a long frame.
      if (drag[slot] > 0) {
        const keep = Math.exp(-drag[slot] * dt);
        vx[slot] *= keep;
        vz[slot] *= keep;
      }
      spin[slot] += tilt[slot] * dt;

      const size = (from[slot] + (END_SIZE - from[slot]) * t) * grow[slot];

      dummy.position.set(px[slot], py[slot], pz[slot]);
      dummy.rotation.set(tilt[slot] * 0.4, spin[slot], 0);
      dummy.scale.set(size * wide[slot], size * SQUASH, size);
      dummy.updateMatrix();
      mesh.setMatrixAt(slot, dummy.matrix);

      alphas[slot] = Math.max(0, 1 - t) ** 1.6 * START_ALPHA;

      if (life[slot] <= 0) {
        dummy.scale.setScalar(0);
        dummy.updateMatrix();
        mesh.setMatrixAt(slot, dummy.matrix);
        alphas[slot] = 0;
      }
    }

    mesh.instanceMatrix.needsUpdate = true;
    geometry.attributes.aAlpha.needsUpdate = true;
    if (tinted) {
      mesh.instanceColor.needsUpdate = true;
      tinted = false;
    }
  }

  return { mesh, add, burst, wreckSmoke, update };
}
