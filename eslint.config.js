/**
 * Shared lint rules for the TypeScript/React source.
 * The recommended presets catch language and type-aware mistakes, while the
 * React plugins enforce hook correctness and safe component-refresh boundaries.
 */
import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  // Build output is generated and should not be linted as authored source.
  { ignores: ['dist'] },
  {
    // Combine general JavaScript checks with the TypeScript ESLint recommendations.
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    // Apply this browser-oriented rule set to both plain and JSX TypeScript files.
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      // Match the JavaScript syntax level supported by the app's toolchain.
      ecmaVersion: 2020,
      // Recognize browser globals such as `window` without requiring imports.
      globals: globals.browser,
    },
    plugins: {
      // These plugins add rules specific to React hooks and Fast Refresh.
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      // Keep React's recommended hook dependency and call-order checks enabled.
      ...reactHooks.configs.recommended.rules,
      // Warn rather than fail when a module's exports can interfere with
      // Fast Refresh; constant exports remain valid alongside components.
      'react-refresh/only-export-components': [
        'warn',
        { allowConstantExport: true },
      ],
    },
  }
);
