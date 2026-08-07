import * as THREE from 'three';

// Off-screen drop-off pointer.
//
// When a fare is aboard the drop-off can sit behind the viewport edge — the map is bigger than the
// frame on portrait and the player has been panning. Losing sight of where to drive at costs a
// beat. This arrow rides the viewport edge in the drop-off's own teal, pointing at the ring the
// taxi is meant to reach, so the direction is always readable from the HUD.
//
// It carries more than it used to. The drop-off was a crystal floating at rooftop height, which
// stayed visible over the skyline for a while after the ring itself had gone behind something; now
// the marker is the ring and nothing else, and this is the only thing that reports it off-frame.
//
// One colour, because the drop-off has one state: it is dispatched at pickup, so there is no
// waiting-to-be-tapped state for the arrow to distinguish. It briefly had two, matching a pin that
// opened teal until tapped.
//
// The indicator only shows for a *riding* fare, which is also the only fare with a drop-off ring on
// the map: a waiting rider's destination stays hidden until they board. One pointer, aimed at the
// trip actually under way.

const EDGE_MARGIN = 36;   // px kept clear from the viewport edge, so the arrow lives on the HUD
                          // rather than sliced by it

export function createDropoffIndicator({ camera, pinLocation }) {
  const el = document.getElementById('dropoff-indicator');
  if (!el) return { update: () => {} };

  const projected = new THREE.Vector3();
  let visible = false;

  function setVisible(next) {
    if (visible === next) return;
    visible = next;
    el.hidden = !next;
  }
  setVisible(false);

  function update(fare) {
    // No pointer for a waiting rider: their diamond and their finder chip already handle that job.
    if (!fare || fare.stage !== 'riding') {
      setVisible(false);
      return;
    }

    const w = window.innerWidth;
    const h = window.innerHeight;
    const c = pinLocation(fare.target.i, fare.target.j);
    // Aimed at the ring on the road, which is the whole marker now. It used to aim halfway up the
    // pin's post so the arrow pointed at the crystal rather than at the tarmac under it.
    projected.set(c.x, 0.1, c.z).project(camera);
    const sx = (projected.x * 0.5 + 0.5) * w;
    const sy = (-projected.y * 0.5 + 0.5) * h;

    // Fully on-screen with a small margin: the pin itself is visible, no arrow needed.
    if (sx >= EDGE_MARGIN && sx <= w - EDGE_MARGIN
      && sy >= EDGE_MARGIN && sy <= h - EDGE_MARGIN) {
      setVisible(false);
      return;
    }

    setVisible(true);

    // Clamp along the line from the viewport centre to the projected point, so the arrow sits
    // where the pin would exit the frame.
    const cx = w / 2;
    const cy = h / 2;
    const dx = sx - cx;
    const dy = sy - cy;
    const maxX = cx - EDGE_MARGIN;
    const maxY = cy - EDGE_MARGIN;
    // Guard the divide when the projected point coincides with the centre.
    const scale = Math.min(
      Math.abs(dx) > 0.001 ? maxX / Math.abs(dx) : Infinity,
      Math.abs(dy) > 0.001 ? maxY / Math.abs(dy) : Infinity,
    );
    const px = cx + dx * scale;
    const py = cy + dy * scale;
    const angleDeg = (Math.atan2(dy, dx) * 180) / Math.PI;

    el.style.left = `${px}px`;
    el.style.top = `${py}px`;
    el.style.transform = `translate(-50%, -50%) rotate(${angleDeg.toFixed(2)}deg)`;
  }

  return { update };
}
