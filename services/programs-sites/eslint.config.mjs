// Lint configuration: typescript-eslint recommended rules over sources, tests and configs.
import { defineConfig, globalIgnores } from 'eslint/config';
import tseslint from 'typescript-eslint';

export default defineConfig(globalIgnores(['dist/', 'coverage/', 'src/generated/']), tseslint.configs.recommended, {
  // A leading underscore marks a binding kept unused on purpose: an omitted destructured key or an unused parameter.
  rules: {
    '@typescript-eslint/no-unused-vars': [
      'error',
      { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_', destructuredArrayIgnorePattern: '^_', ignoreRestSiblings: true },
    ],
  },
});
