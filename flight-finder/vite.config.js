import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      // In dev, forward to `netlify dev` (which runs the function locally on :8888)
      // so the app can call the same relative /api path it uses in production.
      '/api': { target: 'http://localhost:8888', changeOrigin: true },
    },
  },
});
