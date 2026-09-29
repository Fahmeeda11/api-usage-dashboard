import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    /**
     * Proxy /api and /auth to the Express server in development.
     *
     * This means the browser only ever talks to one origin, which sidesteps CORS
     * and - more importantly - lets the refresh cookie behave in development
     * exactly as it will in production behind a single domain. Developing
     * cross-origin and deploying same-origin (or vice versa) is how cookie bugs
     * stay hidden until launch day.
     */
    proxy: {
      '/api': {
        target: 'http://localhost:4000',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
      '/auth': {
        target: 'http://localhost:4000',
        changeOrigin: true,
      },
    },
  },
  build: {
    sourcemap: true,
  },
});
