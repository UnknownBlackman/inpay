import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

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

export default defineConfig({
  root: import.meta.dirname,
  plugins: [react(), spaRoutes()],
  build: {
    assetsDir: 'bundle',
    rollupOptions: { input: { index: path.join(import.meta.dirname, 'index.html'), app: path.join(import.meta.dirname, 'app.html') } },
  },
  server: {
    host: '127.0.0.1',
    port: Number(process.env.WEB_PORT ?? 5190),
    strictPort: true,
    proxy: { '/api': api, '/mockbank': api, '/providers': api, '/agent': api, '/try': api },
  },
});
