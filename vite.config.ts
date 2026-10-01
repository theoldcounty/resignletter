import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

/**
 * Vite's build and development-server configuration for the React client.
 * Values exposed through `import.meta.env` are compiled into browser code and
 * must remain public configuration, never Stripe secret keys or other credentials.
 */
export default defineConfig({
  // The React plugin transforms JSX and enables the React development experience.
  plugins: [react()],
  define: {
    // Inject only non-secret selectors/identifiers. JSON.stringify makes the
    // configured values valid JavaScript literals in Vite's compile-time replacement.
    'import.meta.env.VITE_STRIPE_MODE': JSON.stringify(process.env.STRIPE_MODE ?? 'test'),
    'import.meta.env.VITE_GA_MEASUREMENT_ID': JSON.stringify(process.env.GA_MEASUREMENT_ID ?? ''),
  },
  server: {
    // Listen on the container interface and the port used by the Replit preview.
    host: '0.0.0.0',
    port: 5000,
    // Replit preview hostnames are dynamic, so allow the preview proxy to reach Vite.
    allowedHosts: true,
  },
  resolve: {
    alias: {
      // Let source imports use `@/…` instead of relative paths across directories.
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  optimizeDeps: {
    // Keep the icon package out of Vite's dependency pre-bundling path, which
    // avoids optimizer issues with its module shape.
    exclude: ['lucide-react'],
  },
});
