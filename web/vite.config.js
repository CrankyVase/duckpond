import { createReadStream, cpSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { LOBE_ICON_FILES } from './src/lib/lobeIconFiles.js';

const lobeIconDir = fileURLToPath(new URL('./node_modules/@lobehub/icons-static-svg/icons/', import.meta.url));
const lobeIconNames = [...new Set(Object.values(LOBE_ICON_FILES))];

function lobeIcons() {
  return {
    name: 'lobe-icons',
    configureServer(server) {
      server.middlewares.use('/hub/logo', (req, res, next) => {
        const name = decodeURIComponent(String(req.url || '/').split('?')[0].replace(/^\//, ''));
        if (!name.endsWith('.svg') || name.includes('/') || name.includes('..')) return next();
        const file = join(lobeIconDir, name);
        if (!existsSync(file)) return next();
        res.setHeader('Content-Type', 'image/svg+xml');
        res.setHeader('Cache-Control', 'public, max-age=86400');
        createReadStream(file).pipe(res);
      });
    },
    writeBundle(options) {
      const dest = join(options.dir || 'dist', 'hub', 'logo');
      mkdirSync(dest, { recursive: true });
      for (const name of lobeIconNames) cpSync(join(lobeIconDir, name), join(dest, name));
    },
  };
}

export default defineConfig({
  plugins: [svelte(), lobeIcons()],
  server: {
    port: 5199,
    proxy: {
      '/api': { target: 'http://127.0.0.1:8090', changeOrigin: false },
    },
  },
  build: { target: 'es2022' },
});
