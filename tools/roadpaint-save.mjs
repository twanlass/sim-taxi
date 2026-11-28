// The dev server's half of the road paint tool (game/roadpaint.js): the ⚙️ panel's "Save to repo"
// POSTs the finished module source here and it lands in src/city/roadpaintbake.js, ready to commit.
// Dev server only (`apply: 'serve'`), loopback only, and it writes that one file and nothing else.
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const TARGET = fileURLToPath(new URL('../src/city/roadpaintbake.js', import.meta.url));
const LIMIT = 64 * 1024 * 1024;

export function roadPaintSaver() {
  return {
    name: 'road-paint-saver',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/__roadpaint', (req, res) => {
        const local = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
        if (req.method !== 'POST' || !local) { res.statusCode = 403; res.end(); return; }
        let body = '';
        let size = 0;
        req.setEncoding('utf8');
        req.on('data', (chunk) => {
          size += chunk.length;
          if (size > LIMIT) { res.statusCode = 413; res.end(); req.destroy(); return; }
          body += chunk;
        });
        req.on('end', async () => {
          if (res.writableEnded) return;
          // Only ever the one export the panel writes: anything else is refused rather than written.
          if (!/^\/\/[^\n]*\n\/\/[^\n]*\nexport const ROAD_PAINT_BAKE = \{[^\n]*\};\n$/.test(body)) {
            res.statusCode = 400; res.end('not a road paint bake'); return;
          }
          await writeFile(TARGET, body);
          res.end('ok');
        });
      });
    },
  };
}
