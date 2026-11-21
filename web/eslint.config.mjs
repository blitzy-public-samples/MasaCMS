import { defineConfig, globalIgnores } from 'eslint/config';
import nextPlugin from '@next/eslint-plugin-next';
import nextTypescript from 'eslint-config-next/typescript';

// eslint-config-next's full presets load react, import and jsx-a11y plugins that support ESLint 9 at most.
export default defineConfig(
  globalIgnores(['dist/', 'coverage/', 'src/generated/', '.next/', 'next-env.d.ts']),
  nextTypescript,
  nextPlugin.configs['core-web-vitals'],
  {
    rules: {
      // A leading underscore marks a binding left unused on purpose.
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          destructuredArrayIgnorePattern: '^_',
          varsIgnorePattern: '^_',
        },
      ],
      // next/typescript lowers this to a warning.
      '@typescript-eslint/no-unused-expressions': 'error',
    },
  },
);
