/**
 * CSS processing chain used by Vite: Tailwind expands utility directives,
 * then Autoprefixer adds browser-specific prefixes for the generated styles.
 */
export default {
  plugins: {
    // Generate the app's utility CSS from the class names found by Tailwind.
    tailwindcss: {},
    // Normalize vendor-prefix differences without hand-maintained CSS variants.
    autoprefixer: {},
  },
};
