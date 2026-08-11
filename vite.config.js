import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

// Two pages, not one. The game is `/` and the passing lab is `/lab/` — see docs/lab.md for what
// the lab is and why it isn't reachable from the game.
//
// The dev server finds `lab/index.html` on its own; this file exists for `npm run build`, which
// only walks `index.html` unless it is told about the others, and would otherwise ship a `dist/`
// with the lab silently missing. Nothing else here is configured: Vite's defaults were already
// what this project wants.
export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
        lab: fileURLToPath(new URL('./lab/index.html', import.meta.url)),
      },
      output: {
        // Two entries sharing three.js means Rollup extracts a common chunk whether or not it is
        // asked to, and it names that chunk after whichever module happens to sit at the top of
        // it — left alone, the first build called the 516kB three.js bundle `shot-*.js`, after
        // `util/shot.js`, and the name would move again the next time the import graph shifted.
        // Naming it is not cosmetic: `public/sw.js` precaches whatever `/assets/*` paths it finds
        // in the shipped `index.html`, and the offline shell is only as debuggable as that list.
        //
        // **`node_modules` and nothing else.** An earlier version of this also folded `/src/` into
        // a shared `app` chunk, which swept `src/main.js` in with it — and `main.js` *boots the
        // game* on import. Every page that touched the shared chunk therefore started a whole
        // second game behind itself: `/lab/` came up with the city's road network installed under
        // the lab's own, and the console filled with the sim dereferencing junctions that were not
        // on the road it was driving. Rollup already keeps every entry module in its own entry
        // chunk; the moment a rule here overrides that, an import turns into a boot. Anything
        // under `src/` is off limits to this function.
        manualChunks: (id) => (id.includes('node_modules') ? 'vendor' : undefined),
      },
    },
  },
});
