import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { managedAudience } from '@opt2/platform/auth';
import { queueDefinition, targetUrl } from '@opt2/platform/tasks';

import { REPO_ROOT } from '../../src/lib/paths.js';
import { PLAN_TFVARS_RELATIVE_PATH, TFVARS_RELATIVE_PATH, type TopologyTfvars } from '../../src/repro/pubsub-topology.js';

const PLAN_MAIN = 'infra/terraform/envs/plan/main.tf';
const CLOUD_RUN_MAIN = 'infra/terraform/modules/cloud_run_service/main.tf';
const PUBSUB_MAIN = 'infra/terraform/modules/pubsub_topic/main.tf';

const read = (relative: string): string => readFileSync(path.join(REPO_ROOT, relative), 'utf8');
const topology = JSON.parse(read(TFVARS_RELATIVE_PATH)) as TopologyTfvars;
const planTfvars = read(PLAN_TFVARS_RELATIVE_PATH);

/** A quoted string input of `plan.tfvars`. */
function tfvar(name: string): string {
  const value = new RegExp(`^${name}\\s*=\\s*"([^"]*)"`, 'm').exec(planTfvars)?.[1];
  if (value === undefined) throw new Error(`plan.tfvars sets no ${name}`);
  return value;
}

/** `local.urls[name]` of the plan composition. */
function serviceUrl(name: string): string {
  return `https://${name}-${tfvar('project_number')}.${tfvar('region')}.run.app`;
}

const subscriptions = Object.entries(topology.subscriptions).map(([name, entry]) => ({ name, ...entry }));
const queues = Object.entries(topology.queues).map(([name, entry]) => ({ name, ...entry }));

describe('Cloud Run custom audiences', () => {
  it('are composed in Terraform from the push endpoints and fixed queue target paths of each service', () => {
    const plan = read(PLAN_MAIN);
    expect(plan).toContain('[for s in var.subscriptions : "${local.urls[n]}${s.push_path}" if s.consumer == n]');
    expect(plan).toContain('[for q in var.queues : "${local.urls[n]}${q.target_path}" if q.target_service == n]');
    expect(plan).toContain('condition     = alltrue([for q in var.queues : !strcontains(q.target_path, "{")])');
    expect(plan).toMatch(/push_endpoint\s+= "\$\{local\.urls\[v\.consumer\]\}\$\{v\.push_path\}"/);
    expect(plan).toMatch(/custom_audiences\s+= local\.custom_audiences\[each\.key\]/);
    expect(read(CLOUD_RUN_MAIN)).toMatch(/custom_audiences = var\.custom_audiences/);
    expect(read(PUBSUB_MAIN)).toMatch(/audience\s+= each\.value\.push_endpoint/);
  });

  it('are checked against a non-empty committed cloud topology', () => {
    expect(subscriptions.length).toBeGreaterThan(0);
    expect(queues.length).toBeGreaterThan(0);
  });

  it.each(subscriptions)('admit the $name push audience the platform verifies', ({ consumer, push_path }) => {
    expect(managedAudience(serviceUrl(consumer), push_path)).toBe(`${serviceUrl(consumer)}${push_path}`);
  });

  it.each(queues)('admit the $name task URL as the audience the platform sends and verifies', ({ name, target_service, target_path }) => {
    expect(target_path).toMatch(/^(\/[a-z0-9-]+)+$/);
    const registered = `${serviceUrl(target_service)}${target_path}`;
    const delivered = new URL(targetUrl(queueDefinition(name), { [target_service]: serviceUrl(target_service) }));
    expect(delivered.href).toBe(registered);
    expect(managedAudience(delivered.origin, delivered.pathname)).toBe(registered);
    expect(managedAudience(serviceUrl(target_service), delivered.pathname)).toBe(registered);
  });
});
