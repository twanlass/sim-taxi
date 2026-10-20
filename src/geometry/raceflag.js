import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { bakeColor, propMaterial, setFinish, FINISH } from '../util/geo.js';
import { color } from '../palette.js';

// The chequered flag the street race is announced and finished with (game/race.js): one over the
// rival's roof while the challenge stands, one planted on the corner the race is run to.
//
// A pole and a 4 × 3 chequer of thin boxes, one merged mesh. **Turned to face the camera** rather
// than the street: the view never rotates and looks down the −X−Z diagonal, so a cloth hung along
// either axis is seen at 45° and its squares go to diamonds. Yawed by π/4 it is square on, which is
// what makes a chequer read as a chequer at 20 pixels.
//
// Sized off the play zoom (1 unit ≈ 7.7px): 2.4 across is ~18px of flag, the smallest a 4 × 3
// chequer still reads as one at. Smaller and it is a grey smudge on a stick.

export const FLAG_W = 2.4;
export const FLAG_H = 1.6;
const COLS = 4;
const ROWS = 3;
const CLOTH_T = 0.06;
const POLE_W = 0.12;

function box(w, h, d, x, y, z, paint) {
  const geometry = new THREE.BoxGeometry(w, h, d);
  geometry.translate(x, y, z);
  return setFinish(bakeColor(geometry, color(paint)), FINISH.PAINT);
}

/**
 * The flag, standing on its own origin: the pole runs from y = 0 to `pole`, the cloth hangs off the
 * top of it toward local +X. Answers `{ group, cloth }`; `cloth` is the part that waves.
 */
export function createRaceFlag({ pole = 2.6 } = {}) {
  const group = new THREE.Group();
  group.name = 'race-flag';
  // Square on to the camera — see the note above.
  group.rotation.y = Math.PI / 4;

  const stick = new THREE.Mesh(
    box(POLE_W, pole, POLE_W, 0, pole / 2, 0, 'raceFlagPole'),
    propMaterial(),
  );
  stick.castShadow = true;
  group.add(stick);

  // The cloth hangs from a hinge at the top of the pole so a yaw about it reads as the flag flying.
  const hinge = new THREE.Group();
  hinge.position.set(POLE_W / 2, pole, 0);
  const cw = FLAG_W / COLS;
  const ch = FLAG_H / ROWS;
  const parts = [];
  for (let c = 0; c < COLS; c++) {
    for (let r = 0; r < ROWS; r++) {
      const dark = (c + r) % 2 === 0;
      parts.push(box(cw, ch, CLOTH_T, cw * (c + 0.5), -ch * (r + 0.5), 0,
        dark ? 'raceFlagDark' : 'raceFlagLight'));
    }
  }
  const clothGeometry = mergeGeometries(parts, false);
  parts.forEach((p) => p.dispose());
  const cloth = new THREE.Mesh(clothGeometry, propMaterial());
  cloth.castShadow = true;
  hinge.add(cloth);
  group.add(hinge);

  return { group, cloth: hinge };
}
