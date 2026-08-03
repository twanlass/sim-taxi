import * as THREE from 'three';

// Off-screen drop-off pointer.
//
// When a fare is aboard the destination pin can sit behind the viewport edge — the map is bigger
// than the frame on portrait and the player has been panning. Losing sight of where to drive at
// costs a beat. This arrow rides the viewport edge in the drop-off's fare colour, pointing at the
// pin the taxi is meant to reach, so the direction is always readable from the HUD.
//
// The indicator only shows for a *riding* fare — a waiting rider has the light shaft and the
// finder button already, and colour hasn't been assigned yet so a coloured pointer would lie.

const EDGE_MARGIN = 36;   // px kept clear from the viewport edge, so the arrow lives on the HUD
                          // rather than sliced by it

export function createDropoffIndicator({ camera, intersectionCentre }) {
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
    // No pointer for a waiting rider: the light shaft and finder chip already handle that job,
    // and the fare's colour is not assigned until pickup.
    if (!fare || fare.stage !== 'riding') {
      setVisible(false);
      return;
    }

    const w = window.innerWidth;
    const h = window.innerHeight;
    const c = intersectionCentre(fare.target.i, fare.target.j);
    // Aim at the pin head, not the road, so a pointer clamped to the edge still reads as "the
    // marker" rather than a spot on the tarmac.
    projected.set(c.x, 5, c.z).project(camera);
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
    if (fare.color) el.style.setProperty('--dropoff-color', fare.color);
  }

  return { update };
}
