import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  define: {
    'import.meta.env.VITE_STRIPE_MODE': JSON.stringify(process.env.STRIPE_MODE ?? 'test'),
    'import.meta.env.VITE_GA_MEASUREMENT_ID': JSON.stringify(process.env.GA_MEASUREMENT_ID ?? ''),
  },
  server: {
    host: '0.0.0.0',
    port: 5000,
    allowedHosts: true,
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  optimizeDeps: {
    exclude: ['lucide-react'],
  },
});
