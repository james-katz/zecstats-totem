import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  publicDir: 'assets',
  server: {
    proxy: {
      '/api': 'http://localhost:4000',
    },
  },
});
