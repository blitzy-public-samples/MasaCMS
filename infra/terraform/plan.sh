#!/usr/bin/env bash
# Plan-only check of infra/terraform/envs/plan (init, fmt, validate, plan, show); writes opt2/reports/terraform-plan.json.
set -euo pipefail

readonly TF_REQUIRED=1.17.1
readonly REDACTED='(redacted)'
# Google provider and gcloud credential variables, unset before terraform runs.
readonly GOOGLE_CREDENTIAL_ENV=(GOOGLE_APPLICATION_CREDENTIALS GOOGLE_CREDENTIALS GOOGLE_CLOUD_KEYFILE_JSON
  GCLOUD_KEYFILE_JSON GOOGLE_OAUTH_ACCESS_TOKEN CLOUDSDK_AUTH_ACCESS_TOKEN GOOGLE_IMPERSONATE_SERVICE_ACCOUNT)

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

if (($# == 1)) && [[ $1 == -h || $1 == --help ]]; then
  cat <<EOF
usage: infra/terraform/plan.sh [-h|--help]

Plan-only check of infra/terraform/envs/plan, run from infra/terraform/ with no credentials: terraform init
(no backend), fmt -check, validate, plan (no refresh, no lock) and show -json, whose output is written with the
Cloud Run minimum instance counts to \$OPT2_REPORTS_DIR/terraform-plan.json.

Requires: terraform $TF_REQUIRED and node on PATH.

Environment:
  OPT2_STATE_DIR    state directory holding tfplan, the binary plan (default: \$HOME/.opt2/state)
  OPT2_REPORTS_DIR  report directory, relative to the repository root (default: opt2/reports)

Credentials: refused or stripped, never used.
  Refused (exit 1 before init): TF_VAR_plan_access_token set; TF_CLI_ARGS or TF_CLI_ARGS_<command> set; a
  plan.tfvars, terraform.tfvars[.json] or *.auto.tfvars[.json] in envs/plan that names plan_access_token.
  Stripped from terraform's environment:
$(printf '    %s\n' "${GOOGLE_CREDENTIAL_ENV[@]}")
  The report replaces every value terraform marks sensitive with "$REDACTED".

Exit: 0 plan report written, 1 failure or usage error.
EOF
  exit 0
fi

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

# Planning takes no credentials: refuse every way to supply the provider token, strip ambient Google credentials.
[[ ! -v TF_VAR_plan_access_token ]] || fail "TF_VAR_plan_access_token is set; planning takes no credentials"
for name in $(compgen -e); do
  [[ $name != TF_CLI_ARGS && $name != TF_CLI_ARGS_* ]] || fail "$name is set; plan.sh fixes its own terraform arguments"
done
for file in envs/plan/plan.tfvars envs/plan/terraform.tfvars envs/plan/terraform.tfvars.json envs/plan/*.auto.tfvars \
  envs/plan/*.auto.tfvars.json; do
  if [[ -f $file ]] && grep -q -- plan_access_token "$file"; then
    fail "$file names plan_access_token; planning takes no credentials"
  fi
done
unset "${GOOGLE_CREDENTIAL_ENV[@]}"

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
  "$TF_VERSION" "$REDACTED" "${REPORTED_COMMANDS[@]}" <<'EOF'
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';

const [pinFile, showFile, reportFile, terraformVersion, marker, ...commands] = process.argv.slice(2);
const tmpFile = `${reportFile}.tmp-${process.pid}`;

try {
  const { sha } = JSON.parse(readFileSync(pinFile, 'utf8'));
  if (typeof sha !== 'string' || sha === '') throw new Error(`${pinFile} has no sha`);
  const plan = JSON.parse(readFileSync(showFile, 'utf8'));

  // Each value terraform marks sensitive becomes the marker; `sensitive` mirrors the value's shape, nulls stay null.
  let redactions = 0;
  const redact = (value, sensitive) => {
    if (value === null || value === undefined) return value;
    if (sensitive === true) {
      redactions += 1;
      return marker;
    }
    if (sensitive === null || typeof sensitive !== 'object' || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map((item, i) => redact(item, sensitive[i]));
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redact(item, sensitive[key])]));
  };
  const redactConstant = (expression) => {
    if (expression !== undefined && 'constant_value' in expression) expression.constant_value = redact(expression.constant_value, true);
  };
  const redactResources = (module) => {
    for (const resource of module?.resources ?? []) resource.values = redact(resource.values, resource.sensitive_values);
    for (const child of module?.child_modules ?? []) redactResources(child);
  };
  const redactChange = (change) => {
    if (change === undefined) return;
    change.before = redact(change.before, change.before_sensitive);
    change.after = redact(change.after, change.after_sensitive);
  };
  // Sensitive variable defaults, and constants passed to sensitive module variables.
  const redactModuleConfig = (module) => {
    for (const variable of Object.values(module?.variables ?? {})) {
      if (variable.sensitive === true && 'default' in variable) variable.default = redact(variable.default, true);
    }
    for (const call of Object.values(module?.module_calls ?? {})) {
      for (const [name, variable] of Object.entries(call.module?.variables ?? {})) {
        if (variable.sensitive === true) redactConstant(call.expressions?.[name]);
      }
      redactModuleConfig(call.module);
    }
  };

  const rootVariables = plan.configuration?.root_module?.variables;
  const inputs = Object.entries(plan.variables ?? {});
  if (inputs.length > 0 && rootVariables === undefined) throw new Error('the plan declares no variables to tell sensitive inputs by');
  for (const [name, input] of inputs) if (rootVariables[name]?.sensitive === true) input.value = redact(input.value, true);
  redactModuleConfig(plan.configuration?.root_module);
  for (const provider of Object.values(plan.configuration?.provider_config ?? {})) {
    for (const key of ['access_token', 'credentials']) redactConstant(provider.expressions?.[key]);
  }
  for (const values of [plan.planned_values, plan.prior_state?.values]) {
    redactResources(values?.root_module);
    for (const output of Object.values(values?.outputs ?? {})) if (output.sensitive === true) output.value = redact(output.value, true);
  }
  const deferred = (plan.deferred_changes ?? []).map((entry) => entry.resource_change);
  for (const resource of [...(plan.resource_changes ?? []), ...(plan.resource_drift ?? []), ...deferred]) redactChange(resource?.change);
  for (const change of Object.values(plan.output_changes ?? {})) redactChange(change);

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
        'migration',
      ],
      cloudRunJobs: ['db-bootstrap'],
      minInstanceCount: { default: 0, migration: 1 },
    },
    minInstanceCounts,
    plan,
  };

  writeFileSync(tmpFile, `${JSON.stringify(report)}\n`);
  renameSync(tmpFile, reportFile);
  console.log(
    `plan.sh: wrote ${reportFile} (${Object.keys(minInstanceCounts).length} Cloud Run services, ${redactions} sensitive values redacted)`,
  );
} catch (err) {
  rmSync(tmpFile, { force: true });
  console.error(`plan.sh: cannot write the report: ${err.message}`);
  process.exit(1);
}
EOF
