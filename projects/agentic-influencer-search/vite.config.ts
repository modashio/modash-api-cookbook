import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const API_PORT = process.env.PORT ?? '3000';

/**
 * Vite rejects requests whose Host header it doesn't recognise, which protects
 * the dev server against DNS rebinding. That also blocks legitimate access
 * through a proxy or tunnel — an IDE's built-in browser, ngrok, a codespace
 * forwarder. Name those hosts in VITE_ALLOWED_HOSTS, or set it to `all` if you
 * are in a throwaway sandbox and don't care.
 */
const allowedHosts = (() => {
  const raw = process.env.VITE_ALLOWED_HOSTS?.trim();
  if (!raw) return undefined;
  if (raw === 'all') return true as const;
  return raw.split(',').map((host) => host.trim()).filter(Boolean);
})();

export default defineConfig({
  root: 'src/web',
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    // Bind every interface, not just loopback. Without this Vite answers on ::1
    // only, which breaks browsers that resolve localhost to 127.0.0.1 and any
    // setup where the browser is outside the host running Vite — containers,
    // devcontainers, WSL, VMs.
    host: true,
    ...(allowedHosts === undefined ? {} : { allowedHosts }),
    proxy: {
      // The browser never sees the Modash token: everything goes through our own API.
      '/api': `http://127.0.0.1:${API_PORT}`,
    },
  },
  build: {
    outDir: '../../dist/web',
    emptyOutDir: true,
  },
});
