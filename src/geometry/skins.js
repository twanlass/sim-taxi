import { createSkin } from '../util/paint.js';
import TAXI from '../../assets/skins/taxi.json' with { type: 'json' };

// The shipped skins, one per vehicle type — painted in the garage (`/garage/`, docs/garage.md) and
// saved over these files. A skin is built once and shared: every mesh of a type reads one texture,
// so a fleet costs what one car does.
//
// Only the taxi so far. A new type is a file here plus a `propMaterial({ paint })` and
// `stampPaintPos` at its construction site.

const FILES = { taxi: TAXI };
const skins = new Map();

/** The live skin for `name`, built on first ask. */
export function getSkin(name) {
  let skin = skins.get(name);
  if (!skin) {
    if (!FILES[name]) throw new Error(`skins: no skin file for ${name}`);
    skin = createSkin(name, FILES[name]);
    skins.set(name, skin);
  }
  return skin;
}

export const SKIN_NAMES = Object.keys(FILES);

// A save from the garage rewrites the file, and the dev server hands the new contents to every open
// page — so a game tab repaints its taxi in place, with no reload and no lost run. The garage itself
// gets its own save echoed back and skips it (`saved`), or a stroke made in the instant between
// the save and the echo would be painted over.
if (import.meta.hot) {
  import.meta.hot.accept('../../assets/skins/taxi.json', (mod) => {
    const skin = skins.get('taxi');
    const file = mod?.default;
    if (skin && file && file.data !== skin.saved) skin.load(file);
  });
}
