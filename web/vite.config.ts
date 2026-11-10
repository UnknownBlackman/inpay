import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// INPay uses its own ports (API 8790, web 5190) so it can run next to other local projects.
// strictPort: fail loudly if the port is taken instead of silently moving to another one.
const api = `http://127.0.0.1:${process.env.PORT ?? 8790}`;
export default defineConfig({
  root: import.meta.dirname,
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: Number(process.env.WEB_PORT ?? 5190),
    strictPort: true,
    proxy: { '/api': api, '/mockbank': api, '/providers': api, '/agent': api },
  },
});
