/**
 * Effect pools that skip their draw call while every slot is empty.
 *
 * Every particle effect in the game is an `InstancedMesh` sized for its worst moment — 512 dust
 * puffs, 256 motes of boat wake, a crash's shards and tyres — and parks a dead slot by scaling it
 * to zero. That is the right shape for a pool, but three cannot tell a zero-scale instance from a
 * live one, so a pool with nothing in it still costs a full draw: the program bound, the uniforms
 * set, every one of its instances run through the vertex shader to a degenerate triangle. On an
 * ordinary frame **27** of the main pass's ~140 draws were pools like that (measured mid-run,
 * 22 cars, no crash in progress), and the casters among them paid again in the shadow pass.
 *
 * `cullEmptyPools()` runs before the frame's passes and hides a registered pool whose every
 * instance has a zero 3×3 — the one test that can only ever be true of an instance that draws
 * nothing. Anything a pool hides some other way (an alpha of zero, a slot moved off the map) reads
 * as live and keeps drawing, so the sweep can only skip work, never a visible thing.
 *
 * **Only from the third frame on.** A pool hidden from the start never reaches the renderer, so its
 * program would link on the frame the first spark flies — a driver stall timed to land on the
 * crash. Two frames drawn as before compiles everything first (see `tools/links.mjs`), and a
 * program outlives its mesh being hidden.
 *
 * A registered pool must leave `visible` to this module; none of them set it themselves.
 */

const pools = new Set();
let framesSeen = 0;

/** Register a zero-scale-parked pool. Returns the mesh, so it can wrap a constructor. */
export function skipWhenEmpty(mesh) {
  pools.add(mesh);
  return mesh;
}

/** Whether any of the first `count` instances has a non-zero linear part. */
function anyLive(mesh) {
  const a = mesh.instanceMatrix.array;
  const end = Math.min(mesh.count, mesh.instanceMatrix.count) * 16;
  for (let i = 0; i < end; i += 16) {
    if (a[i] !== 0 || a[i + 1] !== 0 || a[i + 2] !== 0
      || a[i + 4] !== 0 || a[i + 5] !== 0 || a[i + 6] !== 0
      || a[i + 8] !== 0 || a[i + 9] !== 0 || a[i + 10] !== 0) return true;
  }
  return false;
}

/** Called once before each frame's render passes. */
export function cullEmptyPools() {
  if (framesSeen < 2) { framesSeen += 1; return; }
  for (const mesh of pools) mesh.visible = anyLive(mesh);
}
