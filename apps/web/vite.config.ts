import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Security invariant: the dev server binds loopback only. `host` must stay the
// literal loopback IP below - never a wildcard or all-interfaces bind. The
// check-no-spawner gate enforces this across the whole tree.
export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:4317',
      },
    },
  },
  // `vite preview` serves the production build; pin it to loopback too so no
  // build ever exposes the app on the LAN.
  preview: {
    host: '127.0.0.1',
  },
});
