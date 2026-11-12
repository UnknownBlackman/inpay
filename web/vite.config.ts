import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import fs from 'node:fs';

// Windows: one drive-letter case for every path (a 'c:' vs 'C:' mismatch breaks Vite's inline-CSS
// lookup for index.html), whatever case the shell that started the build used.
const ROOT = import.meta.dirname.replace(/^[a-z]:/, (d) => d.toUpperCase());

// INPay uses its own ports (API 8790, web 5190) so it can run next to other local projects.
const api = `http://127.0.0.1:${process.env.PORT ?? 8790}`;

// Two pages: the static landing (index.html at /) and the React app (app.html) for
// /dashboard, /pay/:id and /bank/:merchant.
const appRoutes = /^\/(dashboard|pay\/|bank\/)/;
const spaRoutes = (): Plugin => ({
  name: 'inpay-app-routes',
  configureServer(server) {
    server.middlewares.use((req, _res, next) => {
      if (req.url && appRoutes.test(req.url)) req.url = '/app.html';
      next();
    });
  },
  configurePreviewServer(server) {
    server.middlewares.use((req, _res, next) => {
      if (req.url && appRoutes.test(req.url)) req.url = '/app.html';
      next();
    });
  },
});

// The logos live in web/brand, beside index.html, so the landing page finds them however it is
// opened (dev server, any static host or sub-path, or straight from disk). Dev serves them at
// /brand from the root; a build copies the folder as-is, so the app's /brand/... paths work too.
const copyBrand = (): Plugin => ({
  name: 'inpay-copy-brand',
  apply: 'build',
  closeBundle() {
    fs.cpSync(path.join(ROOT, 'brand'), path.join(ROOT, 'dist', 'brand'), { recursive: true });
  },
});

export default defineConfig({
  root: ROOT,
  publicDir: false,
  plugins: [react(), spaRoutes(), copyBrand()],
  build: {
    assetsDir: 'bundle',
    rollupOptions: { input: { index: path.join(ROOT, 'index.html'), app: path.join(ROOT, 'app.html') } },
  },
  server: {
    host: '127.0.0.1',
    port: Number(process.env.WEB_PORT ?? 5190),
    strictPort: true,
    proxy: { '/api': api, '/mockbank': api, '/providers': api, '/agent': api, '/try': api },
  },
});
