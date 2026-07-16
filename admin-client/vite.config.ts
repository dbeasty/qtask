import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5174,
    proxy: {
      // Admin API is served by the dedicated admin listener (ADMIN_PORT).
      '/api': 'http://localhost:3004',
    },
  },
});
