import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';

/**
 * The garage's Save button (docs/garage.md): `POST /__garage/save/<name>` with a skin file as the
 * body writes it over `assets/skins/<name>.json`, and the dev server's own file watcher then hands
 * the new skin to every open page. Dev server only — a built bundle has nowhere to write, so the
 * garage falls back to downloading the file there.
 *
 * Deliberately narrow: it overwrites skins that already exist and nothing else, and checks the
 * body is shaped like one before it touches the disk. A typo in a name never creates a file.
 */
function garageSave() {
  const MAX_BYTES = 8 << 20;
  return {
    name: 'garage-save',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/__garage/save/', (req, res) => {
        const reply = (status, body) => {
          res.statusCode = status;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(body));
        };
        const name = /^\/([a-z0-9-]+)$/.exec(req.url ?? '')?.[1];
        const file = name && fileURLToPath(new URL(`./assets/skins/${name}.json`, import.meta.url));
        if (req.method !== 'POST' || !name || !existsSync(file)) return reply(404, { error: 'no such skin' });
        const chunks = [];
        let size = 0;
        req.on('data', (chunk) => {
          size += chunk.length;
          if (size > MAX_BYTES) req.destroy();
          else chunks.push(chunk);
        });
        req.on('end', async () => {
          let skin;
          try { skin = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { skin = null; }
          const shaped = skin && skin.version === 1 && typeof skin.data === 'string'
            && typeof skin.voxel === 'number' && skin.voxel > 0
            && [skin.min, skin.dims].every((v) => Array.isArray(v) && v.length === 3
              && v.every(Number.isFinite));
          if (!shaped) return reply(400, { error: 'not a skin file' });
          await writeFile(file, `${JSON.stringify(skin, null, 2)}\n`);
          reply(200, { saved: `assets/skins/${name}.json` });
        });
      });
    },
  };
}

// Three pages, not one. The game is `/`, the passing lab is `/lab/` and the paint garage is
// `/garage/` — see docs/lab.md and docs/garage.md. Neither workbench is reachable from the game.
//
// The dev server finds `lab/index.html` on its own; this file exists for `npm run build`, which
// only walks `index.html` unless it is told about the others, and would otherwise ship a `dist/`
// with the lab silently missing. Nothing else here is configured: Vite's defaults were already
// what this project wants.
export default defineConfig({
  plugins: [garageSave()],
  build: {
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
        lab: fileURLToPath(new URL('./lab/index.html', import.meta.url)),
        garage: fileURLToPath(new URL('./garage/index.html', import.meta.url)),
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
