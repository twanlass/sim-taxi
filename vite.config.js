import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

// Two pages: the game at / and the vehicle editor at /editor.html. Vite's dev server serves any
// root-level .html without configuration; this input list exists so `vite build` emits both.
export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
        editor: fileURLToPath(new URL('./editor.html', import.meta.url)),
      },
    },
  },
});
