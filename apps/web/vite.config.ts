import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const DAEMON = 'http://127.0.0.1:17878';

export default defineConfig({
  base: '/',
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: {
      '/api': { target: DAEMON, changeOrigin: false },
      '/mcp': { target: DAEMON, changeOrigin: false },
    },
  },
});
