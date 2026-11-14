import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { repoPath } from '../../src/lib/paths.js';
import { portFor } from '../../src/repro/ports.js';

interface ServerTemplate {
  env?: Record<string, unknown>;
}

const TEMPLATE = JSON.parse(readFileSync(repoPath('harness/repro/server.json.template'), 'utf8')) as ServerTemplate;

describe('server.json.template', () => {
  it.each(['MURA_PORT', 'MURA_PROXYPORT'])('sets %s to the gateway port from ports.env', (name) => {
    expect(TEMPLATE.env?.[name]).toBe(String(portFor('gateway')));
  });
});
