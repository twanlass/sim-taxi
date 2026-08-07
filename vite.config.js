import { defineConfig } from 'vite';
import { resolve } from 'node:path';

// Two entry points: the game, and the level editor.
//
// Naming `index.html` explicitly is not optional. Supplying `rollupOptions.input` replaces vite's
// default input rather than adding to it, so listing only the editor would build a `dist/` with no
// game in it — and the failure looks like a deploy problem rather than a config one.
//
// `import.meta.dirname` because package.json is `"type": "module"`, which leaves `__dirname`
// undefined. Node 22 per netlify.toml.
export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, 'index.html'),
        editor: resolve(import.meta.dirname, 'editor.html'),
      },
    },
  },
});
