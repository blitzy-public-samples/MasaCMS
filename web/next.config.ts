import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { NextConfig } from 'next';
import { legacyHeaders } from '@opt2/platform/legacy-compat';

// Next always runs from web/; the repository root also covers the ../platform symlink target.
const repoRoot = path.resolve(process.cwd(), '..');

const platformManifest = JSON.parse(readFileSync(path.join(repoRoot, 'platform', 'package.json'), 'utf8')) as {
  dependencies: Record<string, string>;
};

// Legacy order: request-start Strict-Transport-Security and Generator, then the admin layout's Expires.
const legacyPageHeaders = [
  ...Object.entries(legacyHeaders()).map(([key, value]) => ({ key, value })),
  { key: 'Expires', value: '06 Nov 1994 08:37:34 GMT' },
];

const nextConfig: NextConfig = {
  turbopack: { root: repoRoot },
  outputFileTracingRoot: repoRoot,
  // Turbopack still bundles the symlinked platform (real path outside node_modules), so its dependencies stay external.
  serverExternalPackages: ['@opt2/platform', ...Object.keys(platformManifest.dependencies)],
  poweredByHeader: false,
  generateEtags: false,
  async headers() {
    return ['/admin/:circuit/:action', '/opt2/admin/:module/:screen'].map((source) => ({
      source,
      headers: legacyPageHeaders,
    }));
  },
};

export default nextConfig;
