// `document.documentElement.client{Width,Height}` rather than `window.inner{Width,Height}`. On an
// installed iOS PWA with `viewport-fit=cover` + `black-translucent` (see index.html), the two
// disagree at the bottom edge: `window.innerHeight` stops short of the home indicator's safe area
// even though the laid-out `<html>` (sized off `100dvh`) correctly runs full-bleed underneath it.
// Anything sized or projected off the shorter value — the renderer, the off-screen drop-off arrow —
// leaves a gap or clamps early at that edge. `clientHeight` tracks the box that's actually laid out.
export function viewportSize() {
  return {
    width: document.documentElement.clientWidth,
    height: document.documentElement.clientHeight,
  };
}
