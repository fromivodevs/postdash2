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
    // Allow tunneled hosts in dev (cloudflared / ngrok / vscode dev tunnels).
    // Vite 5+ blocks unknown Host headers by default as DNS-rebinding protection.
    // Dev-only; production build is served by a real host with its own headers.
    allowedHosts: [
      '.trycloudflare.com',
      '.ngrok-free.app',
      '.ngrok.io',
      '.devtunnels.ms',
      'localhost',
    ],
  },
  build: {
    target: 'es2022',
    sourcemap: true,
  },
});
