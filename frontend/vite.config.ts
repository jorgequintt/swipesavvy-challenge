import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// In dev, Vite serves the UI on :5173 and forwards /api to the nginx proxy, so the
// blue/green badge and the flip work exactly as in the built app.
// Point it elsewhere with e.g. VITE_API_TARGET=http://localhost:3000 npm run dev
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': process.env.VITE_API_TARGET ?? 'http://localhost:8088',
    },
  },
});
