// Tell TypeScript-aware editors the shape of this JavaScript Tailwind config.
/** @type {import('tailwindcss').Config} */
export default {
  // Scan the HTML entry point and React source so used utility classes are emitted.
  // Omitting other paths keeps production CSS limited to classes the app uses.
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    // Keep Tailwind defaults; place project-wide design-token overrides here.
    extend: {},
  },
  // No extra Tailwind plugins are required by the current utility set.
  plugins: [],
};
