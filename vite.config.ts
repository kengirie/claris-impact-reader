import { defineConfig, type Plugin } from 'vite';
import { readFile } from 'node:fs/promises';
import { resolve, normalize } from 'node:path';

/** Dev only: serves files from ./samples as raw bytes under /__sample/. */
function rawSamples(): Plugin {
  const root = resolve(__dirname, 'samples');
  return {
    name: 'raw-samples',
    configureServer(server) {
      server.middlewares.use('/__sample/', async (req, res) => {
        const rel = decodeURIComponent((req.url ?? '').split('?')[0]);
        const path = normalize(resolve(root, '.' + rel));
        if (!path.startsWith(root)) {
          res.statusCode = 403;
          res.end();
          return;
        }
        try {
          const data = await readFile(path);
          res.setHeader('Content-Type', 'application/octet-stream');
          res.end(data);
        } catch {
          res.statusCode = 404;
          res.end();
        }
      });
    },
  };
}

export default defineConfig({
  base: './',
  plugins: [rawSamples()],
  server: { port: 5199, strictPort: true },
  build: { target: 'es2022' },
});
