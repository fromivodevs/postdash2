import react from '@vitejs/plugin-react-swc';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  // Read .env from monorepo root, not apps/miniapp/.
  // Без этого root .env игнорируется и VITE_* fallback'ятся на defaults.
  envDir: '../..',
  server: {
    port: 5173,
    host: '0.0.0.0',
    open: '/',
  },
  build: {
    target: 'es2022',
    sourcemap: true,
  },
});
