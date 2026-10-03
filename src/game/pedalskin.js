/**
 * Alternative looks for the gas and brake, picked with `?pedals=`:
 *
 *   outline — two plain pedal outlines, brake left and gas right the way they sit in a car. The
 *             fuel fills the gas pedal from the floor up, so there is no separate gauge.
 *   speedo  — a speedometer in the middle of the bottom edge with the fuel as an arc over its top,
 *             brake hugging its left side and gas its right.
 *   dash    — a 1970s cab's dashboard across the bottom of the screen, seen from the driver's
 *             seat: speedo, a LOCO fuel gauge, idiot lights, and the two pedals at either end.
 *   gauge   — arch, grown a speedometer: the gas dome is the hub of a dial whose needle sweeps
 *             above it, the fuel band runs round the outside of the dial, and the brake is a red
 *             pedal of its own beside it. Same HUD moves as arch.
 *   arch    — the shipped pedals, rearranged: the gas becomes an orange dome in the middle of the
 *             bottom edge with the fuel band following its top, the brake moves to the corner,
 *             and neither carries an icon. The rest of the HUD moves round to suit: the cash total
 *             top-left, pause top-right, and the cargo chip down into the bottom-right corner.
 *
 * Anything else (or nothing) keeps the Figma pedals in index.html. This is a skin and only a skin:
 * the controls are still `#boost` and `#brake`, pressed through the same pedal slide in main.js,
 * and every state a skin draws is a class main.js already sets on them (`is-held`, `is-down`,
 * `is-on`, `is-active`, `is-empty`). What a skin moves is where the two buttons sit — their boxes
 * are what `pedalUnder` hit-tests, and they must still never overlap — and it adds one read-out
 * element (`#pedal-readout`, pointer-events: none) for whatever it draws that is not a control.
 *
 * Self-contained on purpose, CSS included, so trying a look and throwing it away are both one file.
 */

const SKINS = ['outline', 'speedo', 'dash', 'arch', 'gauge'];

// 22.1 u/s is the Loco cruise and reads as 65mph (BOOST_SPEED in sim/traffic.js).
const MPH_PER_UNIT = 65 / 22.1;
const DIAL_MPH = 100;

const f = (n) => n.toFixed(2);

/** A point on a dial, with 0° straight up and angles running clockwise. */
function polar(cx, cy, r, deg) {
  const a = ((deg - 90) * Math.PI) / 180;
  return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
}

/** A band between two radii from `a0` to `a1` degrees (0° up, clockwise), as a filled outline. */
function bandPath(cx, cy, r0, r1, a0, a1) {
  if (a1 - a0 < 0.05) return '';
  const large = a1 - a0 > 180 ? 1 : 0;
  const [ox0, oy0] = polar(cx, cy, r1, a0);
  const [ox1, oy1] = polar(cx, cy, r1, a1);
  const [ix1, iy1] = polar(cx, cy, r0, a1);
  const [ix0, iy0] = polar(cx, cy, r0, a0);
  return `M${f(ox0)} ${f(oy0)}A${r1} ${r1} 0 ${large} 1 ${f(ox1)} ${f(oy1)}`
    + `L${f(ix1)} ${f(iy1)}A${r0} ${r0} 0 ${large} 0 ${f(ix0)} ${f(iy0)}Z`;
}

/** Tick marks round a dial: `n` gaps from `a0` to `a1`, every `major`th one long. */
function ticks(cx, cy, r, a0, a1, n, major, cls) {
  let d = '';
  for (let i = 0; i <= n; i++) {
    const a = a0 + ((a1 - a0) * i) / n;
    const len = i % major === 0 ? 7 : 3.5;
    const [x0, y0] = polar(cx, cy, r, a);
    const [x1, y1] = polar(cx, cy, r - len, a);
    d += `M${f(x0)} ${f(y0)}L${f(x1)} ${f(y1)}`;
  }
  return `<path class="${cls}" d="${d}"/>`;
}

function dialNumbers(cx, cy, r, a0, a1, values, cls) {
  return values.map((v, i) => {
    const a = a0 + ((a1 - a0) * i) / (values.length - 1);
    const [x, y] = polar(cx, cy, r, a);
    return `<text class="${cls}" x="${f(x)}" y="${f(y)}">${v}</text>`;
  }).join('');
}

// --- outline ---------------------------------------------------------------

function outlineArt() {
  const ribs = (x0, x1, ys) => ys.map((y) => `M${x0} ${y}H${x1}`).join('');
  return {
    brake: `<svg class="skin-art" viewBox="0 0 104 78">
      <rect class="o-body" x="3" y="3" width="98" height="72" rx="14"/>
      <path class="o-ribs" d="${ribs(20, 84, [24, 34, 44, 54])}"/>
    </svg>`,
    gas: `<svg class="skin-art" viewBox="0 0 70 132">
      <defs><clipPath id="o-gas-clip"><rect x="3" y="3" width="64" height="126" rx="12"/></clipPath></defs>
      <rect class="o-body" x="3" y="3" width="64" height="126" rx="12"/>
      <rect class="o-fuel" x="0" y="132" width="70" height="0" clip-path="url(#o-gas-clip)"/>
      <path class="o-ribs" d="${ribs(18, 52, [26, 40, 54, 68, 82, 96, 110])}"/>
      <rect class="o-rim" x="3" y="3" width="64" height="126" rx="12"/>
    </svg>`,
  };
}

const OUTLINE_CSS = `
  body.pedals-outline { --ctl-h: 132px; }
  body.pedals-outline #brake { left: var(--ctl-left); width: 104px; height: 78px; }
  body.pedals-outline #boost { left: calc(var(--ctl-left) + 114px); width: 70px; height: 132px; }
  body.pedals-outline .skin-art { display: block; width: 100%; height: 100%; overflow: visible;
    pointer-events: none; transition: transform 0.07s ease-out, filter 0.15s ease; }
  .pedals-outline .o-body { fill: rgba(16, 22, 28, 0.35); }
  .pedals-outline .o-rim, .pedals-outline #brake .o-body { stroke: #fff; stroke-width: 3.5; }
  .pedals-outline .o-rim { fill: none; }
  .pedals-outline .o-ribs { stroke: #fff; stroke-width: 3; stroke-linecap: round; opacity: 0.85; }
  .pedals-outline .o-fuel { fill: #FFC21A; opacity: 0.7; }
  body.pedals-outline #boost.is-held .skin-art, body.pedals-outline #boost.is-down .skin-art,
  body.pedals-outline #brake.is-held .skin-art, body.pedals-outline #brake.is-on .skin-art { transform: translateY(3px) scale(0.97); }
  .pedals-outline #brake.is-on .o-body { fill: rgba(230, 60, 45, 0.85); }
  .pedals-outline #boost.is-active .o-rim { stroke: #FFE27A; }
  .pedals-outline #boost.is-active .o-fuel { opacity: 0.95; }
  body.pedals-outline #boost.is-active .skin-art { filter: drop-shadow(0 0 8px rgba(255, 200, 0, 0.9)); }
  body.pedals-outline #boost.is-filling .skin-art {
    filter: drop-shadow(0 0 calc(3px + 8px * var(--pulse, 0)) rgba(255, 190, 0, calc(0.9 * var(--fill, 0)))); }
  body.pedals-outline #boost.is-empty .skin-art { opacity: 0.55; }
  .pedals-outline #boost.is-empty .o-fuel { fill: #b9a77a; }
`;

// --- speedo ----------------------------------------------------------------

// The dial and the two wings that hug it. All in CSS px, laid out round the dial's centre.
const SP = {
  r: 54,         // dial face
  arc0: 62,      // fuel band, inner radius
  arc1: 71,      // fuel band, outer radius
  fuelA: 58,     // the band spans ±this many degrees either side of straight up
  wingW: 72, wingH: 84,
  wingIn: 40,    // how far from the dial's centre the wing's box starts
  hug: 64,       // radius of the wing's concave edge: the face plus a 10px gap
  box: 160,      // the read-out's box, square
};
SP.cy = SP.box - SP.r - 6; // the dial sits on the row's floor, a little proud of the face
SP.sweep0 = -135; SP.sweep1 = 135;

/** A wing with its concave edge on the left, wrapping a circle of radius `hug` whose centre is
 *  `wingIn` px to the left of the box and level with `cy` (in the box's own coordinates). */
function wingPath(w, h, wingIn, hug, cy, rr = 14) {
  const cx = -wingIn;
  const topX = cx + Math.sqrt(hug * hug - cy * cy);         // where the circle crosses y = 0
  const exitY = cy + Math.sqrt(hug * hug - wingIn * wingIn); // where it crosses x = 0
  return `M${f(topX)} 0H${w - rr}Q${w} 0 ${w} ${rr}V${h - rr}Q${w} ${h} ${w - rr} ${h}H${rr}`
    + `Q0 ${h} 0 ${h - rr}V${f(Math.min(exitY, h - rr))}A${hug} ${hug} 0 0 0 ${f(topX)} 0Z`;
}

function speedoArt() {
  const wingCy = SP.wingH - SP.r - 6; // dial centre, in the wing's box
  const wing = wingPath(SP.wingW, SP.wingH, SP.wingIn, SP.hug, wingCy);
  const c = SP.box / 2;
  const chevron = `M${SP.wingW * 0.55 - 9} ${SP.wingH * 0.5 + 4}l9 -9l9 9`;
  return {
    gas: `<svg class="skin-art" viewBox="0 0 ${SP.wingW} ${SP.wingH}">
      <path class="s-wing" d="${wing}"/>
      <path class="s-glyph" d="${chevron}M${SP.wingW * 0.55 - 9} ${SP.wingH * 0.5 + 14}l9 -9l9 9"/>
      <text class="s-label" x="${SP.wingW * 0.55}" y="${SP.wingH - 14}">GAS</text>
    </svg>`,
    brake: `<svg class="skin-art" viewBox="0 0 ${SP.wingW} ${SP.wingH}">
      <g transform="translate(${SP.wingW} 0) scale(-1 1)"><path class="s-wing" d="${wing}"/></g>
      <rect class="s-glyph-fill" x="${SP.wingW * 0.45 - 10}" y="${SP.wingH * 0.5 - 12}" width="20" height="20" rx="3"/>
      <text class="s-label" x="${SP.wingW * 0.45}" y="${SP.wingH - 14}">BRAKE</text>
    </svg>`,
    readout: `<svg viewBox="0 0 ${SP.box} ${SP.box}" overflow="visible">
      <defs>
        <linearGradient id="s-fuel-grad" x1="0" x2="1"><stop stop-color="#FFD500"/><stop offset="1" stop-color="#FF7A00"/></linearGradient>
      </defs>
      <path class="s-track" d="${bandPath(c, SP.cy, SP.arc0 - 2, SP.arc1 + 2, -SP.fuelA - 1.5, SP.fuelA + 1.5)}"/>
      <path class="s-fuel" d="" fill="url(#s-fuel-grad)"/>
      <circle class="s-face" cx="${c}" cy="${SP.cy}" r="${SP.r}"/>
      <path class="s-red" d="${bandPath(c, SP.cy, SP.r - 7, SP.r - 3, SP.sweep0 + 270 * 0.65, SP.sweep1)}"/>
      ${ticks(c, SP.cy, SP.r - 3, SP.sweep0, SP.sweep1, 20, 4, 's-ticks')}
      ${dialNumbers(c, SP.cy, SP.r - 17, SP.sweep0, SP.sweep1, [0, 20, 40, 60, 80, 100], 's-num')}
      <text class="s-mph" x="${c}" y="${SP.cy + 24}">0</text>
      <text class="s-unit" x="${c}" y="${SP.cy + 35}">MPH</text>
      <g class="s-needle" style="transform-origin:${c}px ${SP.cy}px">
        <path d="M${c - 2.5} ${SP.cy}L${c} ${SP.cy - SP.r + 9}L${c + 2.5} ${SP.cy}Z"/>
      </g>
      <circle class="s-hub" cx="${c}" cy="${SP.cy}" r="5"/>
    </svg>`,
  };
}

const SPEEDO_CSS = `
  body.pedals-speedo { --ctl-h: ${SP.box}px; }
  /* The cluster is centred, so the pause square moves to the empty top-left corner. */
  body.pedals-speedo #pause { bottom: auto; right: auto; top: var(--hud-top); left: max(var(--hud-side), var(--safe-left)); }
  body.pedals-speedo #brake, body.pedals-speedo #boost { width: ${SP.wingW}px; height: ${SP.wingH}px; }
  body.pedals-speedo #brake { left: calc(50% - ${SP.wingIn + SP.wingW}px); }
  body.pedals-speedo #boost { left: calc(50% + ${SP.wingIn}px); }
  #pedal-readout.speedo { position: fixed; z-index: 19; left: calc(50% - ${SP.box / 2}px);
    bottom: var(--ctl-bottom); width: ${SP.box}px; height: ${SP.box}px; pointer-events: none; }
  #pedal-readout.speedo svg { display: block; width: 100%; height: 100%; }
  body.pedals-speedo .skin-art { display: block; width: 100%; height: 100%; overflow: visible;
    pointer-events: none; transition: transform 0.07s ease-out, filter 0.15s ease; }
  .pedals-speedo .s-wing { stroke: rgba(0, 0, 0, 0.55); stroke-width: 2; }
  .pedals-speedo #boost .s-wing { fill: #F5C130; }
  .pedals-speedo #brake .s-wing { fill: #E5483B; }
  .pedals-speedo .s-glyph { fill: none; stroke: #2a1a00; stroke-width: 4; stroke-linecap: round; stroke-linejoin: round; }
  .pedals-speedo .s-glyph-fill { fill: #fff; }
  .pedals-speedo .s-label { font: 900 11px var(--hud-font); text-anchor: middle; letter-spacing: 0.08em; }
  .pedals-speedo #boost .s-label { fill: #2a1a00; }
  .pedals-speedo #brake .s-label { fill: #fff; }
  body.pedals-speedo #boost.is-held .skin-art, body.pedals-speedo #boost.is-down .skin-art,
  body.pedals-speedo #brake.is-held .skin-art, body.pedals-speedo #brake.is-on .skin-art { transform: scale(0.93); filter: brightness(0.85); }
  body.pedals-speedo #brake.is-on .skin-art { filter: brightness(1.15) drop-shadow(0 0 8px rgba(255, 60, 40, 0.9)); }
  body.pedals-speedo #boost.is-active .skin-art { filter: drop-shadow(0 0 8px rgba(255, 200, 0, 0.95)); }
  body.pedals-speedo #boost.is-empty .skin-art { filter: grayscale(1); opacity: 0.6; }
  .speedo .s-track { fill: rgba(20, 14, 0, 0.75); }
  .speedo.is-empty .s-fuel { filter: saturate(0.35) brightness(0.8); }
  .speedo.is-active .s-fuel { filter: drop-shadow(0 0 5px rgba(255, 200, 0, 0.95)); }
  .speedo.is-filling .s-fuel { filter: drop-shadow(0 0 calc(3px + 6px * var(--pulse, 0)) rgba(255, 190, 0, calc(0.95 * var(--fill, 0)))); }
  .speedo .s-face { fill: rgba(14, 22, 30, 0.88); stroke: #fff; stroke-width: 3; }
  .speedo .s-red { fill: #E5483B; }
  .speedo .s-ticks { stroke: #fff; stroke-width: 1.6; stroke-linecap: round; }
  .speedo .s-num { fill: #cfd8df; font: 700 9px var(--hud-font); text-anchor: middle; dominant-baseline: central; }
  .speedo .s-mph { fill: #fff; font: 900 17px var(--hud-font); text-anchor: middle; font-variant-numeric: tabular-nums; }
  .speedo .s-unit { fill: #9fb0bc; font: 800 7px var(--hud-font); text-anchor: middle; letter-spacing: 0.12em; }
  .speedo .s-needle path { fill: #FF5A2A; }
  .speedo .s-hub { fill: #fff; }
`;

// --- dash ------------------------------------------------------------------

// The cluster in the middle of the dash, in its own px.
const DA = { w: 196, h: 112, sx: 98, sy: 62, sr: 46, fx: 26, fy: 74, fr: 22 };

function dashArt() {
  const { sx, sy, sr, fx, fy, fr } = DA;
  const fuel0 = -60, fuel1 = 60;
  return {
    brake: `<svg class="skin-art" viewBox="0 0 88 66">
      <rect class="d-chrome" x="1" y="1" width="86" height="64" rx="7"/>
      <rect class="d-rubber" x="6" y="6" width="76" height="54" rx="4"/>
      <path class="d-grip" d="${[16, 24, 32, 40, 48].map((y) => `M14 ${y}H74`).join('')}"/>
      <text class="d-stamp" x="44" y="58">BRAKE</text>
    </svg>`,
    gas: `<svg class="skin-art" viewBox="0 0 58 108">
      <rect class="d-chrome" x="1" y="1" width="56" height="106" rx="8"/>
      <rect class="d-rubber" x="6" y="6" width="46" height="96" rx="5"/>
      <path class="d-grip" d="${[18, 28, 38, 48, 58, 68, 78].map((y) => `M15 ${y}H43`).join('')}"/>
      <text class="d-stamp" x="29" y="97">GAS</text>
    </svg>`,
    readout: `<div class="d-lip"></div><div class="d-wood"></div>
      <svg class="d-cluster" viewBox="0 0 ${DA.w} ${DA.h}">
        <defs>
          <radialGradient id="d-face" cx="0.5" cy="0.4" r="0.65"><stop stop-color="#FBF1D6"/><stop offset="1" stop-color="#E2CFA1"/></radialGradient>
          <linearGradient id="d-bezel" x1="0" y1="0" x2="0" y2="1"><stop stop-color="#F4F4F4"/><stop offset="0.5" stop-color="#8A8A8A"/><stop offset="1" stop-color="#DADADA"/></linearGradient>
        </defs>
        <rect class="d-pod" x="2" y="10" width="${DA.w - 4}" height="${DA.h - 12}" rx="22"/>
        <circle class="d-fuel-bezel" cx="${fx}" cy="${fy}" r="${fr + 3}" fill="url(#d-bezel)"/>
        <circle cx="${fx}" cy="${fy}" r="${fr}" fill="url(#d-face)"/>
        ${ticks(fx, fy, fr - 1, fuel0, fuel1, 4, 2, 'd-ticks')}
        <text class="d-tiny" x="${fx - 14}" y="${fy - 3}">E</text><text class="d-tiny" x="${fx + 14}" y="${fy - 3}">F</text>
        <text class="d-tiny d-amber" x="${fx}" y="${fy + 12}">LOCO</text>
        <g class="d-fuel-needle" style="transform-origin:${fx}px ${fy}px"><path d="M${fx - 1.4} ${fy}L${fx} ${fy - fr + 4}L${fx + 1.4} ${fy}Z"/></g>
        <circle class="d-hub" cx="${fx}" cy="${fy}" r="2.6"/>
        <circle cx="${sx}" cy="${sy}" r="${sr + 4}" fill="url(#d-bezel)"/>
        <circle cx="${sx}" cy="${sy}" r="${sr}" fill="url(#d-face)"/>
        ${ticks(sx, sy, sr - 2, -130, 130, 20, 2, 'd-ticks')}
        ${dialNumbers(sx, sy, sr - 15, -130, 130, [0, 20, 40, 60, 80, 100], 'd-num')}
        <text class="d-tiny" x="${sx}" y="${sy + 18}">MPH</text>
        <g class="d-odo"><rect x="${sx - 16}" y="${sy + 23}" width="32" height="10" rx="1.5"/><text class="d-odo-text" x="${sx}" y="${sy + 30.5}">00000</text></g>
        <g class="d-needle" style="transform-origin:${sx}px ${sy}px"><path d="M${sx - 2} ${sy + 8}L${sx} ${sy - sr + 6}L${sx + 2} ${sy + 8}Z"/></g>
        <circle class="d-hub" cx="${sx}" cy="${sy}" r="4"/>
        <g class="d-lamp d-lamp-loco"><rect x="${DA.w - 46}" y="44" width="36" height="16" rx="3"/><text x="${DA.w - 28}" y="55">LOCO</text></g>
        <g class="d-lamp d-lamp-brake"><rect x="${DA.w - 46}" y="66" width="36" height="16" rx="3"/><text x="${DA.w - 28}" y="77">BRAKE</text></g>
        <text class="d-badge" x="${DA.w - 28}" y="${DA.h - 10}">SIM CAB</text>
      </svg>
      <svg class="d-wheel" viewBox="0 0 300 60" preserveAspectRatio="none"><path d="M6 60 Q150 -18 294 60" /></svg>`,
  };
}

const DASH_H = 132;
const DASH_CSS = `
  body.pedals-dash { --ctl-h: ${DASH_H - 12}px; --dash-h: calc(${DASH_H}px + var(--safe-bottom)); }
  body.pedals-dash #pause { bottom: auto; right: auto; top: var(--hud-top); left: max(var(--hud-side), var(--safe-left)); }
  body.pedals-dash #brake { left: max(12px, var(--safe-left)); bottom: calc(var(--safe-bottom) + 12px); width: 88px; height: 66px; }
  body.pedals-dash #boost { left: auto; right: max(12px, var(--safe-right)); bottom: calc(var(--safe-bottom) + 12px); width: 58px; height: 108px; }
  #pedal-readout.dash { position: fixed; z-index: 18; left: 0; right: 0; bottom: 0; height: var(--dash-h);
    pointer-events: none; }
  .dash .d-lip { position: absolute; left: -2%; right: -2%; top: 0; height: 26px; border-radius: 50% 50% 0 0 / 100% 100% 0 0;
    background: linear-gradient(#5a3a22, #3a2414 70%, #2a190d);
    box-shadow: 0 -3px 8px rgba(0, 0, 0, 0.45), inset 0 2px 0 rgba(255, 220, 180, 0.18); }
  .dash .d-wood { position: absolute; left: 0; right: 0; top: 18px; bottom: 0;
    background:
      linear-gradient(transparent 0 6px, #E8641B 6px 9px, #F2A21B 9px 12px, #F7D046 12px 15px, transparent 15px),
      repeating-linear-gradient(92deg, rgba(0,0,0,0.0) 0 9px, rgba(40,20,5,0.18) 9px 11px, rgba(0,0,0,0) 11px 23px, rgba(255,210,150,0.07) 23px 25px),
      linear-gradient(#7a4a24, #5c3518 60%, #3f230e); }
  .dash .d-cluster { position: absolute; left: calc(50% - ${DA.w / 2}px); top: 8px; width: ${DA.w}px; height: ${DA.h}px; }
  .dash .d-wheel { position: absolute; left: calc(50% - 150px); top: 2px; width: 300px; height: 52px; overflow: visible; }
  .dash .d-wheel path { fill: none; stroke: #1b120c; stroke-width: 15; stroke-linecap: round; opacity: 0.92; }
  .dash .d-pod { fill: #1c140e; stroke: #0c0806; stroke-width: 2; }
  .dash .d-ticks { stroke: #3b2a1a; stroke-width: 1.3; }
  .dash .d-num { fill: #3b2a1a; font: 700 8.5px Georgia, "Times New Roman", serif; font-style: italic; text-anchor: middle; dominant-baseline: central; }
  .dash .d-tiny { fill: #3b2a1a; font: 800 6px var(--hud-font); text-anchor: middle; letter-spacing: 0.1em; }
  .dash .d-amber { fill: #C4561A; }
  .dash .d-needle path { fill: #E8641B; }
  .dash .d-fuel-needle path { fill: #C4561A; }
  .dash .d-fuel-needle, .dash .d-needle { transition: transform 0.12s linear; }
  .dash .d-hub { fill: #2a1d12; }
  .dash .d-odo rect { fill: #111; }
  .dash .d-odo-text { fill: #eee; font: 700 7px ui-monospace, Menlo, monospace; text-anchor: middle; letter-spacing: 0.05em; }
  .dash .d-lamp rect { fill: #2b2118; stroke: #000; }
  .dash .d-lamp text { fill: #5b4a3a; font: 900 7px var(--hud-font); text-anchor: middle; letter-spacing: 0.06em; }
  .dash.is-active .d-lamp-loco rect { fill: #FFB000; filter: drop-shadow(0 0 4px #FFB000); }
  .dash.is-active .d-lamp-loco text { fill: #3a1d00; }
  .dash.is-braking .d-lamp-brake rect { fill: #FF3B2A; filter: drop-shadow(0 0 4px #FF3B2A); }
  .dash.is-braking .d-lamp-brake text { fill: #fff; }
  .dash .d-badge { fill: #C9A86A; font: italic 900 7px Georgia, serif; text-anchor: middle; letter-spacing: 0.08em; }
  body.pedals-dash .skin-art { display: block; width: 100%; height: 100%; pointer-events: none;
    transition: transform 0.07s ease-out, filter 0.15s ease; transform-origin: 50% 100%; }
  .pedals-dash .d-chrome { fill: #cfcfcf; stroke: #6b6b6b; stroke-width: 1.5; }
  .pedals-dash .d-rubber { fill: #1d1d1d; }
  .pedals-dash .d-grip { stroke: #3c3c3c; stroke-width: 3.5; stroke-linecap: round; }
  .pedals-dash .d-stamp { fill: #8c8c8c; font: 900 7px var(--hud-font); text-anchor: middle; letter-spacing: 0.12em; }
  body.pedals-dash #boost.is-held .skin-art, body.pedals-dash #boost.is-down .skin-art,
  body.pedals-dash #brake.is-held .skin-art, body.pedals-dash #brake.is-on .skin-art { transform: scaleY(0.93); filter: brightness(0.85); }
  body.pedals-dash #boost.is-active .skin-art { filter: drop-shadow(0 0 7px rgba(255, 176, 0, 0.95)); }
  body.pedals-dash #boost.is-empty .skin-art { opacity: 0.55; }
`;



/**
 * The Figma pedals' depth, as filter primitives: a dark side band along the bottom of one flat
 * shape, a faint highlight, a soft shadow under the face, and (pressed) an inner shadow dropped
 * from the top edge so the face reads as sunk into its own outline. In px at the 0.65 the shipped
 * pedals are drawn at; `dark` is the side band's colour.
 */
const shadeFilter = (side, shadow, well, dark = [0.313068, 0.194996, 0.00389115]) => `
    <feFlood flood-opacity="0" result="BackgroundImageFix"/>
    <feBlend in="SourceGraphic" in2="BackgroundImageFix" result="shape"/>
    <feColorMatrix in="SourceAlpha" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0" result="hardAlpha"/>
    <feOffset dy="${side}"/><feComposite in2="hardAlpha" operator="arithmetic" k2="-1" k3="1"/>
    <feColorMatrix values="0 0 0 0 ${dark[0]} 0 0 0 0 ${dark[1]} 0 0 0 0 ${dark[2]} 0 0 0 1 0"/>
    <feBlend in2="shape" result="side"/>
    <feColorMatrix in="SourceAlpha" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0" result="hardAlpha"/>
    <feOffset dy="5"/><feComposite in2="hardAlpha" operator="arithmetic" k2="-1" k3="1"/>
    <feColorMatrix values="0 0 0 0 1 0 0 0 0 1 0 0 0 0 1 0 0 0 0.15 0"/>
    <feBlend in2="side" result="lit"/>
    <feColorMatrix in="SourceAlpha" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0" result="hardAlpha"/>
    <feOffset dy="${shadow}"/><feGaussianBlur stdDeviation="1.3"/>
    <feComposite in2="hardAlpha" operator="arithmetic" k2="-1" k3="1"/>
    <feColorMatrix values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0.25 0"/>
    <feBlend in2="lit" result="shaded"/>
    ${well ? `<feColorMatrix in="SourceAlpha" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0" result="hardAlpha"/>
    <feOffset dy="10"/><feGaussianBlur stdDeviation="1.6"/>
    <feComposite in2="hardAlpha" operator="arithmetic" k2="-1" k3="1"/>
    <feColorMatrix values="0 0 0 0 ${dark[0]} 0 0 0 0 ${dark[1]} 0 0 0 0 ${dark[2]} 0 0 0 0.9 0"/>
    <feBlend in2="shaded"/>` : ''}`;

// --- arch ------------------------------------------------------------------

// The dome, in CSS px and in its own box: flat bottom, straight sides, a half-circle on top.
// The look is the Figma gas pedal's — its gradient and its side band — with every
// filter number scaled by the 0.65 the shipped pedal is drawn at (95px for 146 units).
const AR = { w: 120, h: 96, cx: 60, cy: 63, r: 57, corner: 14, pad: 26 };
// The fuel band: inner edge clear of the dome's outline by a 3px gap and a 1.3px rim, a constant
// 7px wide (the shipped gauge tapers 8 → 14 units; this one was tried tapering 5 → 9px and read
// better even), stopping 80° either side of straight up so its ends clear the brake on a 375pt
// phone.
AR.band0 = AR.r + 1.3 + 3 + 1.3;
AR.width = 7; AR.rim = 1.3; AR.span = 80;

/** The band over the dome from `t0` to `t1` of the full span, as a filled outline. */
function archBand(t0, t1, pad = 0) {
  if (t1 - t0 < 0.001) return '';
  const n = Math.max(2, Math.ceil(64 * (t1 - t0)));
  const outer = [], inner = [];
  for (let i = 0; i <= n; i++) {
    const t = t0 + ((t1 - t0) * i) / n;
    const a = -AR.span + 2 * AR.span * t;
    const w = AR.width;
    outer.push(polar(AR.cx, AR.cy, AR.band0 + w + pad, a));
    inner.push(polar(AR.cx, AR.cy, AR.band0 - pad, a));
  }
  const pts = [...outer, ...inner.reverse()];
  return 'M' + pts.map(([x, y]) => `${f(x)} ${f(y)}`).join('L') + 'Z';
}

function archArt() {
  const { w, h, cx, cy, r, corner } = AR;
  const dome = `M${cx - r} ${cy}A${r} ${r} 0 0 1 ${cx + r} ${cy}V${h - 3 - corner}`
    + `Q${cx + r} ${h - 3} ${cx + r - corner} ${h - 3}H${cx - r + corner}Q${cx - r} ${h - 3} ${cx - r} ${h - 3 - corner}Z`;
  const fx = -4, fy = -4, fw = w + 8, fh = h + 8;
  const region = `x="${fx}" y="${fy}" width="${fw}" height="${fh}" filterUnits="userSpaceOnUse" color-interpolation-filters="sRGB"`;
  const p = AR.pad;
  return {
    gas: `<svg class="skin-art" viewBox="0 0 ${w} ${h}" overflow="visible">
      <defs>
        <filter id="arch-up" ${region}>${shadeFilter(-18, -22, false)}</filter>
        <filter id="arch-down" ${region}>${shadeFilter(-7, -11, true)}</filter>
        <linearGradient id="arch-fill" x1="0" y1="0" x2="${w}" y2="${h}" gradientUnits="userSpaceOnUse">
          <stop stop-color="#FF9E01"/><stop offset="0.157945" stop-color="#FCAD2F"/><stop offset="1" stop-color="#FF9E01"/>
        </linearGradient>
      </defs>
      <path class="a-face" d="${dome}" fill="url(#arch-fill)"/>
      <path d="${dome}" fill="none" stroke="#221500" stroke-width="2.6"/>
    </svg>`,
    readout: `<svg class="a-gauge" viewBox="${-p} ${-p} ${w + 2 * p} ${h + p}" overflow="visible">
      <defs>
        <linearGradient id="arch-fuel" x1="${cx - AR.band0}" y1="0" x2="${cx + AR.band0}" y2="0" gradientUnits="userSpaceOnUse">
          <stop stop-color="#FFD500"/><stop offset="1" stop-color="#FF9200"/>
        </linearGradient>
        <radialGradient id="arch-edge">
          <stop offset="0.35" stop-color="#FFFDF2"/><stop offset="0.6" stop-color="#FFE9A0" stop-opacity="0.9"/>
          <stop offset="1" stop-color="#FFD54A" stop-opacity="0"/>
        </radialGradient>
      </defs>
      <path class="a-track" d="${archBand(0, 1, AR.rim)}"/>
      <path class="a-fuel" d="" fill="url(#arch-fuel)"/>
      <circle class="a-edge" r="0" fill="url(#arch-edge)"/>
    </svg>`,
  };
}

const ARCH_CSS = `
  body.pedals-arch { --ctl-h: 70px; }
  body.pedals-arch #boost { left: calc(50% - ${AR.w / 2}px); width: ${AR.w}px; height: ${AR.h}px; }
  /* The Figma brake at 0.87 of its size: on a 375pt phone the full 113px reaches under the end of
     the fuel band. */
  body.pedals-arch #brake { left: var(--ctl-left); width: 98px; height: 70px; }
  body.pedals-arch #boost .skin-art { display: block; width: 100%; height: 100%; pointer-events: none;
    transition: filter 0.15s ease; }
  .pedals-arch .a-face { filter: url(#arch-up); }
  body.pedals-arch #boost.is-held .a-face, body.pedals-arch #boost.is-down .a-face { filter: url(#arch-down); }
  body.pedals-arch #brake .pedal-icon { display: none; }
  body.pedals-arch #boost.is-empty .skin-art { filter: grayscale(1) brightness(0.9); opacity: 0.7; }
  #pedal-readout.arch { position: fixed; z-index: 19; left: calc(50% - ${AR.w / 2 + AR.pad}px);
    bottom: var(--ctl-bottom); width: ${AR.w + 2 * AR.pad}px; height: ${AR.h + AR.pad}px; pointer-events: none; }
  #pedal-readout.arch svg { display: block; width: 100%; height: 100%;
    transform-origin: 50% ${((AR.cy + AR.pad) / (AR.h + AR.pad)) * 100}%;
    transition: filter 0.15s ease, transform 0.1s ease; }
  .arch .a-track { fill: rgba(34, 21, 0, 0.8); }
  .arch .a-edge { opacity: var(--fill, 0); }
  .arch.is-active svg { filter: drop-shadow(0 0 6px rgba(255, 200, 0, 0.9)); }
  .arch.is-empty .a-fuel { filter: saturate(0.35) brightness(0.8); }
  .arch.is-filling svg { transition: none;
    filter: drop-shadow(0 0 calc(4px + 8px * var(--pulse, 0)) rgba(255, 190, 0, calc(0.95 * var(--fill, 0))));
    transform: scale(calc(1 + 0.035 * var(--pulse, 0))); }
  .arch.is-charging.is-filling svg {
    filter: drop-shadow(0 0 calc(3px + 3px * var(--fill, 0)) rgba(205, 180, 106, calc(0.5 * var(--fill, 0))));
    transform: none; }
  @media (prefers-reduced-motion: reduce) { .arch.is-filling svg { transform: none; } }
`;

// --- gauge -----------------------------------------------------------------

// Everything is laid out round the dome's centre, which sits GA.hub px above the row's floor in
// the middle of the screen. The gas *button* is not just the dome: its box is the inside of the
// dial (GA.btnW × GA.btnH), so a thumb anywhere under the needle presses it — a 80px dome on its
// own is a smaller target than the pill it replaces. The dial is a read-out under it.
const GA = {
  r: 40, hub: 24, corner: 10,        // the dome: radius, centre height, bottom corners
  dial: 80,                          // the speedo's arc
  band0: 87, width: 7, rim: 1.3,     // the fuel band, just outside the dial
  span: 80,                          // both arcs stop 80° either side of straight up
  btnW: 144, btnH: 96,               // the gas button's box
  brakeW: 64, brakeH: 88,
};
// The brake's right edge (13 + 64) against the band's left foot on a 375pt phone, which lands at
// 187.5 − 94·sin 80° = 95: 18px of clear air, and the gas box starts at 115.5.

/** A constant-width band round (0, 0) from `t0` to `t1` of a ±`span`° sweep, as a filled outline. */
function ringBand(r0, width, span, t0, t1, pad = 0) {
  if (t1 - t0 < 0.001) return '';
  const n = Math.max(2, Math.ceil(64 * (t1 - t0)));
  const outer = [], inner = [];
  for (let i = 0; i <= n; i++) {
    const a = -span + 2 * span * (t0 + ((t1 - t0) * i) / n);
    outer.push(polar(0, 0, r0 + width + pad, a));
    inner.push(polar(0, 0, r0 - pad, a));
  }
  return 'M' + [...outer, ...inner.reverse()].map(([x, y]) => `${f(x)} ${f(y)}`).join('L') + 'Z';
}

function gaugeArt() {
  const { r, hub, corner, btnW, btnH, brakeW, brakeH } = GA;
  // The dome in the button's own box: centred, its flat bottom 3px clear of the box's floor.
  const cx = btnW / 2, cy = btnH - hub, base = btnH - 3;
  const dome = `M${cx - r} ${cy}A${r} ${r} 0 0 1 ${cx + r} ${cy}V${base - corner}`
    + `Q${cx + r} ${base} ${cx + r - corner} ${base}H${cx - r + corner}Q${cx - r} ${base} ${cx - r} ${base - corner}Z`;
  const box = (id, w, h) => `x="-4" y="-4" width="${w + 8}" height="${h + 8}" filterUnits="userSpaceOnUse" color-interpolation-filters="sRGB" id="${id}"`;
  const brake = `M14 3H${brakeW - 14}Q${brakeW - 3} 3 ${brakeW - 3} 14V${brakeH - 14}Q${brakeW - 3} ${brakeH - 3} ${brakeW - 14} ${brakeH - 3}`
    + `H14Q3 ${brakeH - 3} 3 ${brakeH - 14}V14Q3 3 14 3Z`;
  const redDark = [0.36, 0.04, 0.03];
  // Ticks every 20mph on the dial, long at 0/60/100-ish ends, all inside the arc.
  const ticks = [];
  for (let i = 0; i <= 10; i++) {
    const a = -GA.span + (2 * GA.span * i) / 10;
    const [x0, y0] = polar(0, 0, GA.dial - 1.5, a);
    const [x1, y1] = polar(0, 0, GA.dial - (i % 5 === 0 ? 9 : 5), a);
    ticks.push(`M${f(x0)} ${f(y0)}L${f(x1)} ${f(y1)}`);
  }
  const top = GA.band0 + GA.width + 6, side = GA.band0 + GA.width + 6;
  return {
    gas: `<svg class="skin-art" viewBox="0 0 ${btnW} ${btnH}" overflow="visible">
      <defs>
        <filter ${box('gauge-up', btnW, btnH)}>${shadeFilter(-16, -20, false)}</filter>
        <filter ${box('gauge-down', btnW, btnH)}>${shadeFilter(-6, -10, true)}</filter>
        <linearGradient id="gauge-fill" x1="${cx - r}" y1="${cy - r}" x2="${cx + r}" y2="${base}" gradientUnits="userSpaceOnUse">
          <stop stop-color="#FF9E01"/><stop offset="0.157945" stop-color="#FCAD2F"/><stop offset="1" stop-color="#FF9E01"/>
        </linearGradient>
      </defs>
      <path class="g-face" d="${dome}" fill="url(#gauge-fill)"/>
      <path d="${dome}" fill="none" stroke="#221500" stroke-width="2.6"/>
    </svg>`,
    brake: `<svg class="skin-art" viewBox="0 0 ${brakeW} ${brakeH}" overflow="visible">
      <defs>
        <filter ${box('gauge-brake-up', brakeW, brakeH)}>${shadeFilter(-16, -20, false, redDark)}</filter>
        <filter ${box('gauge-brake-down', brakeW, brakeH)}>${shadeFilter(-6, -10, true, redDark)}</filter>
        <linearGradient id="gauge-brake-fill" x1="0" y1="0" x2="${brakeW}" y2="${brakeH}" gradientUnits="userSpaceOnUse">
          <stop stop-color="#F0453A"/><stop offset="0.16" stop-color="#FF6A5C"/><stop offset="1" stop-color="#E5382D"/>
        </linearGradient>
      </defs>
      <path class="g-brake-face" d="${brake}" fill="url(#gauge-brake-fill)"/>
      <path d="${brake}" fill="none" stroke="#2a0503" stroke-width="2.6"/>
    </svg>`,
    readout: `<svg class="g-dial" viewBox="${-side} ${-top} ${2 * side} ${top + hub}" overflow="visible">
      <defs>
        <linearGradient id="gauge-fuel" x1="${-GA.band0}" y1="0" x2="${GA.band0}" y2="0" gradientUnits="userSpaceOnUse">
          <stop stop-color="#FFD500"/><stop offset="1" stop-color="#FF9200"/>
        </linearGradient>
        <radialGradient id="gauge-edge">
          <stop offset="0.35" stop-color="#FFFDF2"/><stop offset="0.6" stop-color="#FFE9A0" stop-opacity="0.9"/>
          <stop offset="1" stop-color="#FFD54A" stop-opacity="0"/>
        </radialGradient>
      </defs>
      <path class="g-arc" d="${ringBand(GA.dial - 1.5, 3, GA.span, 0, 1)}"/>
      <path class="g-ticks" d="${ticks.join('')}"/>
      <g class="g-needle"><path d="M-2.6 ${-(r + 4)}L0 ${-(GA.dial - 6)}L2.6 ${-(r + 4)}Z"/></g>
      <path class="g-track" d="${ringBand(GA.band0, GA.width, GA.span, 0, 1, GA.rim)}"/>
      <path class="g-fuel" d="" fill="url(#gauge-fuel)"/>
      <circle class="g-edge" r="0" fill="url(#gauge-edge)"/>
    </svg>`,
  };
}

const GAUGE_W = 2 * (GA.band0 + GA.width + 6);
const GAUGE_H = GA.band0 + GA.width + 6 + GA.hub;
const GAUGE_CSS = `
  body.pedals-gauge { --ctl-h: ${GA.brakeH}px; }
  body.pedals-gauge #boost { left: calc(50% - ${GA.btnW / 2}px); width: ${GA.btnW}px; height: ${GA.btnH}px; }
  body.pedals-gauge #brake { left: var(--ctl-left); width: ${GA.brakeW}px; height: ${GA.brakeH}px; }
  body.pedals-gauge .skin-art { display: block; width: 100%; height: 100%; pointer-events: none; }
  .pedals-gauge .g-face { filter: url(#gauge-up); }
  body.pedals-gauge #boost.is-held .g-face, body.pedals-gauge #boost.is-down .g-face { filter: url(#gauge-down); }
  .pedals-gauge .g-brake-face { filter: url(#gauge-brake-up); }
  body.pedals-gauge #brake.is-held .g-brake-face, body.pedals-gauge #brake.is-on .g-brake-face { filter: url(#gauge-brake-down); }
  body.pedals-gauge #brake.is-on .skin-art { filter: brightness(1.12); }
  body.pedals-gauge #boost.is-empty .skin-art { filter: grayscale(1) brightness(0.9); opacity: 0.7; }
  #pedal-readout.gauge { position: fixed; z-index: 19; left: calc(50% - ${GAUGE_W / 2}px);
    bottom: var(--ctl-bottom); width: ${GAUGE_W}px; height: ${GAUGE_H}px; pointer-events: none; }
  #pedal-readout.gauge svg { display: block; width: 100%; height: 100%;
    transform-origin: 50% ${((GAUGE_H - GA.hub) / GAUGE_H) * 100}%; transition: transform 0.1s ease; }
  .gauge .g-arc { fill: rgba(255, 255, 255, 0.9); filter: drop-shadow(0 1px 1.5px rgba(0, 0, 0, 0.45)); }
  .gauge .g-ticks { stroke: rgba(255, 255, 255, 0.85); stroke-width: 2; stroke-linecap: round; }
  .gauge .g-needle { transition: transform 0.12s linear; }
  .gauge .g-needle path { fill: #fff; filter: drop-shadow(0 1px 1.5px rgba(0, 0, 0, 0.5)); }
  .gauge .g-track { fill: rgba(34, 21, 0, 0.8); }
  .gauge .g-edge { opacity: var(--fill, 0); }
  .gauge .g-fuel, .gauge .g-track { transition: filter 0.15s ease; }
  .gauge.is-active .g-fuel { filter: drop-shadow(0 0 5px rgba(255, 200, 0, 0.95)); }
  .gauge.is-empty .g-fuel { filter: saturate(0.35) brightness(0.8); }
  .gauge.is-filling .g-fuel, .gauge.is-filling .g-track { transition: none;
    filter: drop-shadow(0 0 calc(4px + 8px * var(--pulse, 0)) rgba(255, 190, 0, calc(0.95 * var(--fill, 0)))); }
  .gauge.is-charging.is-filling .g-fuel, .gauge.is-charging.is-filling .g-track {
    filter: drop-shadow(0 0 calc(3px + 3px * var(--fill, 0)) rgba(205, 180, 106, calc(0.5 * var(--fill, 0)))); }
`;

// The HUD round a centred gas (arch and gauge).
const HUD_MOVED_CSS = `
  /* The HUD round the pedals: cash top-left, pause top-right where the cash was, and the cargo
     chip in the bottom-right corner the pause left (createPedalSkin moves it out of #hud, whose
     entrance translate would otherwise be the containing block for a fixed chip). */
  body.pedals-hudmoved #hud { right: auto; left: calc(var(--hud-side) + var(--safe-left)); align-items: flex-start; }
  body.pedals-hudmoved #hud .money { transform-origin: left center; }
  body.pedals-hudmoved #pause { bottom: auto; top: var(--hud-top); right: max(var(--hud-side), var(--safe-right)); }
  body.pedals-hudmoved:not(.hud-ready) #pause { translate: 0 -160%; }
  body.pedals-hudmoved #cargo-chip { position: fixed; margin: 0; z-index: 20; pointer-events: none;
    right: var(--ctl-right); bottom: var(--ctl-bottom); width: 56px; height: 56px; }
  body.pedals-hudmoved #cargo-chip canvas { width: 56px; height: 56px; }
  body.pedals-hudmoved.shot-mode #cargo-chip, body.pedals-hudmoved.game-over #cargo-chip,
  body.pedals-hudmoved.replaying #cargo-chip { display: none; }
`;

// --- shared ----------------------------------------------------------------

const SHARED_CSS = `
  body.pedals-skinned:not(.pedals-arch) .pedal-art, body.pedals-arch #boost .pedal-art,
  body.pedals-skinned #boost-meter { display: none; }
  #pedal-readout { opacity: 0; translate: 0 200%;
    transition: opacity 0.45s ease, translate 0.55s cubic-bezier(0.22, 1, 0.36, 1); }
  body.pedals-ready #pedal-readout, body.hud-ready #pedal-readout { opacity: 1; translate: 0 0; }
  body.shot-mode #pedal-readout, body.game-over #pedal-readout, body.replaying #pedal-readout { display: none; }
  @media (prefers-reduced-motion: reduce) { #pedal-readout { translate: none; } }
`;

/**
 * Install the skin named by `?pedals=`, if any. Returns null when the default pedals stay.
 * `update(speed, fuel, braking)` is called every frame with the taxi's speed in u/s and the fuel
 * level the meter is showing (0..1); `fuelTarget()` is where a delivery's boost sparks should land.
 */
export function createPedalSkin({ boostButton, brakeButton, search = window.location.search }) {
  const name = new URLSearchParams(search).get('pedals');
  if (!SKINS.includes(name) || !boostButton || !brakeButton) return null;

  const art = { outline: outlineArt, speedo: speedoArt, dash: dashArt, arch: archArt, gauge: gaugeArt }[name]();
  const css = { outline: OUTLINE_CSS, speedo: SPEEDO_CSS, dash: DASH_CSS, arch: ARCH_CSS, gauge: GAUGE_CSS }[name];
  const style = document.createElement('style');
  style.textContent = SHARED_CSS + HUD_MOVED_CSS + css;
  document.head.appendChild(style);
  document.body.classList.add('pedals-skinned', `pedals-${name}`);

  // A skin that keeps one of the shipped pedals simply has no art for it.
  if (art.gas) boostButton.insertAdjacentHTML('beforeend', art.gas);
  if (art.brake) brakeButton.insertAdjacentHTML('beforeend', art.brake);

  if (name === 'arch' || name === 'gauge') {
    document.body.classList.add('pedals-hudmoved');
    const chip = document.getElementById('cargo-chip');
    if (chip) document.body.appendChild(chip);
  }

  let readout = null;
  if (art.readout) {
    readout = document.createElement('div');
    readout.id = 'pedal-readout';
    readout.className = name;
    readout.setAttribute('aria-hidden', 'true');
    readout.innerHTML = art.readout;
    boostButton.before(readout);
  }

  const q = (sel) => (readout ?? boostButton).querySelector(sel);
  const outlineFuel = boostButton.querySelector('.o-fuel');
  const speedoFuel = q('.s-fuel');
  const speedoNeedle = q('.s-needle');
  const speedoMph = q('.s-mph');
  const dashNeedle = q('.d-needle');
  const dashFuel = q('.d-fuel-needle');
  const dashOdo = q('.d-odo-text');
  const archFuel = q('.a-fuel');
  const archEdge = q('.a-edge');
  const gaugeFuel = q('.g-fuel');
  const gaugeEdge = q('.g-edge');
  const gaugeNeedle = q('.g-needle');
  const c = SP.box / 2;

  let lastFuel = -1;
  let lastMph = -1;
  let odometer = 0;

  return {
    name,
    /** The read-out, so main.js can hand it the same state classes and variables as #boost. */
    readout,

    update(speed, fuel, braking, dt = 0) {
      const mph = Math.max(0, speed) * MPH_PER_UNIT;
      const turn = Math.min(mph, DIAL_MPH) / DIAL_MPH;
      readout?.classList.toggle('is-braking', braking);

      if (Math.abs(fuel - lastFuel) > 0.0005) {
        lastFuel = fuel;
        if (outlineFuel) {
          const h = 126 * fuel;
          outlineFuel.setAttribute('y', f(129 - h));
          outlineFuel.setAttribute('height', f(h));
        }
        speedoFuel?.setAttribute('d', bandPath(c, SP.cy, SP.arc0, SP.arc1, -SP.fuelA, -SP.fuelA + 2 * SP.fuelA * fuel));
        dashFuel?.style.setProperty('transform', `rotate(${f(-60 + 120 * fuel)}deg)`);
        if (gaugeFuel) {
          gaugeFuel.setAttribute('d', ringBand(GA.band0, GA.width, GA.span, 0, fuel));
          const [x, y] = polar(0, 0, GA.band0 + GA.width / 2, -GA.span + 2 * GA.span * fuel);
          gaugeEdge.setAttribute('cx', f(x));
          gaugeEdge.setAttribute('cy', f(y));
          gaugeEdge.setAttribute('r', f(GA.width));
        }
        if (archFuel) {
          archFuel.setAttribute('d', archBand(0, fuel));
          const w = AR.width;
          const [x, y] = polar(AR.cx, AR.cy, AR.band0 + w / 2, -AR.span + 2 * AR.span * fuel);
          archEdge.setAttribute('cx', f(x));
          archEdge.setAttribute('cy', f(y));
          archEdge.setAttribute('r', f(w));
        }
      }
      speedoNeedle?.style.setProperty('transform', `rotate(${f(SP.sweep0 + (SP.sweep1 - SP.sweep0) * turn)}deg)`);
      gaugeNeedle?.style.setProperty('transform', `rotate(${f(-GA.span + 2 * GA.span * turn)}deg)`);
      dashNeedle?.style.setProperty('transform', `rotate(${f(-130 + 260 * turn)}deg)`);
      const shown = Math.round(mph);
      if (speedoMph && shown !== lastMph) { lastMph = shown; speedoMph.textContent = String(shown); }
      if (dashOdo) {
        // Tenths of a "mile", so a run visibly turns it over.
        odometer += Math.max(0, speed) * dt * MPH_PER_UNIT * 0.01;
        dashOdo.textContent = String(Math.floor(odometer) % 100000).padStart(5, '0');
      }
    },

    fuelTarget() {
      const el = name === 'outline' ? boostButton : name === 'speedo' ? q('.s-track')
        : name === 'arch' ? q('.a-track') : name === 'gauge' ? q('.g-track') : q('.d-fuel-bezel');
      const r = el?.getBoundingClientRect();
      if (!r?.width) return null;
      return { x: r.left + r.width / 2, y: r.top + 3, r: r.width / 2 + 20 };
    },
  };
}

