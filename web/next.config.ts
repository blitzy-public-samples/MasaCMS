import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { NextConfig } from 'next';
import { IDENTITY_ACCEPT_ENCODING } from './src/lib/accept-encoding';

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
  // Page headers come from proxy.ts; the gateway drops Next's own Cache-Control left on compact pages.
  // Next drops the Content-Encoding a proxy sets, so the proxied pages get the negotiated one here.
  async headers() {
    return ['/admin/:circuit/:action', '/opt2/admin/:module/:screen'].map((source) => ({
      source,
      has: [{ type: 'header', key: 'accept-encoding', value: IDENTITY_ACCEPT_ENCODING }],
      headers: [{ key: 'Content-Encoding', value: 'identity' }],
    }));
  },
};

export default nextConfig;
