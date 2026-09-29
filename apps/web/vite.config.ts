import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    // 5174, so both projects' dev servers can run side by side.
    port: 5174,
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
        target: 'http://localhost:4001',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
      '/auth': {
        target: 'http://localhost:4001',
        changeOrigin: true,
      },
    },
  },
  build: {
    sourcemap: true,
    rollupOptions: {
      output: {
        /**
         * Split the vendor libraries out of the app bundle.
         *
         * Recharts is by far the largest dependency here and it is only needed
         * on the dashboard route - bundling it with the app means the login
         * screen downloads a charting library before anyone has signed in.
         * Separate chunks also cache better: shipping an app fix should not
         * invalidate the vendor code, which has not changed.
         *
         * Only recharts is split out. Splitting react and @tanstack into their
         * own chunks as well produced "Circular chunk: react -> query -> react"
         * - they share modules, so forcing them apart makes the chunks import
         * each other. One well-chosen split beats several that fight.
         */
        manualChunks: {
          charts: ['recharts'],
        },
      },
    },
  },
});
