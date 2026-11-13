import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { NextConfig } from 'next';

// Next always runs from web/; the repository root also covers the ../platform symlink target.
const repoRoot = path.resolve(process.cwd(), '..');

const platformManifest = JSON.parse(readFileSync(path.join(repoRoot, 'platform', 'package.json'), 'utf8')) as {
  dependencies: Record<string, string>;
};

const nextConfig: NextConfig = {
  turbopack: { root: repoRoot },
  outputFileTracingRoot: repoRoot,
  // Turbopack still bundles the symlinked platform (real path outside node_modules), so its dependencies stay external.
  serverExternalPackages: ['@opt2/platform', ...Object.keys(platformManifest.dependencies)],
  poweredByHeader: false,
  generateEtags: false,
  // Legacy never compresses dynamic output, so Content-Encoding stays what the container negotiated.
  compress: false,
};

export default nextConfig;
