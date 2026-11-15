#!/usr/bin/env bash
# Plan-only check of infra/terraform/envs/plan (init, fmt, validate, plan, show); writes opt2/reports/terraform-plan.json.
set -euo pipefail

readonly TF_REQUIRED=1.17.1

fail() {
  printf 'plan.sh: %s\n' "$*" >&2
  exit 1
}

# Runs one command, '<state-dir>' expanded to STATE_DIR; records it unexpanded for the report.
step() {
  local name=$1
  shift
  local args=("${@//"<state-dir>"/"$STATE_DIR"}")
  REPORTED_COMMANDS+=("$*")
  printf 'plan.sh: %s: %s\n' "$name" "${args[*]}" >&2
  "${args[@]}" || fail "step '$name' failed"
}

(($# == 0)) || fail "usage: infra/terraform/plan.sh (env: OPT2_STATE_DIR, OPT2_REPORTS_DIR)"

SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/../.." && pwd)"

# Absolute, because -chdir=envs/plan would resolve a relative -out path inside envs/plan.
STATE_DIR="${OPT2_STATE_DIR:-${HOME:?HOME is not set}/.opt2/state}"
mkdir -p -- "$STATE_DIR"
STATE_DIR="$(cd -- "$STATE_DIR" && pwd)"

REPORTS_DIR="${OPT2_REPORTS_DIR:-$REPO_ROOT/opt2/reports}"
[[ $REPORTS_DIR == /* ]] || REPORTS_DIR="$REPO_ROOT/$REPORTS_DIR"
mkdir -p -- "$REPORTS_DIR"

cd -- "$SCRIPT_DIR"
export TF_IN_AUTOMATION=1

command -v terraform >/dev/null || fail "terraform $TF_REQUIRED is required on PATH"
command -v node >/dev/null || fail "node is required on PATH to read terraform JSON and write the report"
TF_VERSION="$(terraform version -json | node -p 'JSON.parse(require("fs").readFileSync(0, "utf8")).terraform_version')" ||
  fail "cannot read the terraform version"
[[ $TF_VERSION == "$TF_REQUIRED" ]] || fail "terraform $TF_REQUIRED required, found $TF_VERSION"

REPORTED_COMMANDS=()
step init terraform -chdir=envs/plan init -backend=false -input=false
step fmt terraform fmt -check -recursive
step validate terraform -chdir=envs/plan validate
step plan terraform -chdir=envs/plan plan -input=false -refresh=false -lock=false -var-file=plan.tfvars \
  '-out=<state-dir>/tfplan'

SHOW_JSON="$(mktemp "$STATE_DIR/tfplan.show.XXXXXX")"
trap 'rm -f -- "$SHOW_JSON"' EXIT
step show terraform -chdir=envs/plan show -json '<state-dir>/tfplan' >"$SHOW_JSON"

node --input-type=module - "$REPO_ROOT/opt2/source-pin.json" "$SHOW_JSON" "$REPORTS_DIR/terraform-plan.json" \
  "$TF_VERSION" "${REPORTED_COMMANDS[@]}" <<'EOF'
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';

const [pinFile, showFile, reportFile, terraformVersion, ...commands] = process.argv.slice(2);
const tmpFile = `${reportFile}.tmp-${process.pid}`;

try {
  const { sha } = JSON.parse(readFileSync(pinFile, 'utf8'));
  if (typeof sha !== 'string' || sha === '') throw new Error(`${pinFile} has no sha`);
  const plan = JSON.parse(readFileSync(showFile, 'utf8'));

  const counts = {};
  const walk = (module) => {
    for (const resource of module?.resources ?? []) {
      if (resource.type !== 'google_cloud_run_v2_service') continue;
      counts[resource.values.name] = resource.values.template[0].scaling[0].min_instance_count;
    }
    for (const child of module?.child_modules ?? []) walk(child);
  };
  walk(plan.planned_values?.root_module);
  const minInstanceCounts = Object.fromEntries(Object.keys(counts).sort().map((name) => [name, counts[name]]));

  // Fields and their order follow the committed opt2/reports/terraform-plan.json placeholder its readers parse.
  const report = {
    sourceSha: sha,
    generatedBy: 'infra/terraform/plan.sh',
    generatedAt: new Date().toISOString(),
    status: 'generated',
    terraformVersion,
    providerVersion: 'hashicorp/google 8.9.0',
    commands,
    applied: false,
    expected: {
      provenance: 'planning',
      cloudRunServices: [
        'gateway',
        'web',
        'identity',
        'people',
        'programs-sites',
        'strategies-content',
        'communications',
        'reporting',
        'surveys',
        'timesheets',
        'finance',
        'e-signature',
        'migration',
      ],
      cloudRunJobs: ['db-bootstrap'],
      minInstanceCount: { default: 0, migration: 1 },
    },
    minInstanceCounts,
    plan,
  };

  writeFileSync(tmpFile, `${JSON.stringify(report, null, 2)}\n`);
  renameSync(tmpFile, reportFile);
  console.log(`plan.sh: wrote ${reportFile} (${Object.keys(minInstanceCounts).length} Cloud Run services)`);
} catch (err) {
  rmSync(tmpFile, { force: true });
  console.error(`plan.sh: cannot write the report: ${err.message}`);
  process.exit(1);
}
EOF
