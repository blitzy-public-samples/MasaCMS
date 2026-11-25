# Golden sets

Source SHA: 696383140578f8dea3ece26f80cd7bfb370ddf0f

Outputs captured from legacy Masa that parity replay compares against. This README is the only authored file here; every set is written by the capture.

## Writer and readers

- `harness/src/golden/capture.ts` (`npm run golden:capture` in `harness/`) writes the sets during `harness/repro/test-all.sh` stage 5. It captures against legacy directly (`LEGACY_ORIGIN`, else `http://127.0.0.1:${PORT}`), after `opt2-ops drain-and-suspend` has suspended background work: first every scenario but the GS-PE-RH ones, those declaring `acrossTransition` (GS-ID-09) ahead of the rest, then, after the browser captures, `golden:capture -- --rehearsal`.
- Sets are committed after a capture run and never hand-edited. To change one, re-run the capture (`npm run golden:capture -- --only <scenario-id>`, with `--rehearsal` for a rehearsal crossing's set).
- `harness/src/golden/replay.ts` replays the same step scripts through the gateway (`OPT2_GATEWAY_URL`, else `http://127.0.0.1:8100`) in capture order: GS-ID-09 across the `v0002` activation in stage 6, the other scenarios in catalogue order with `v0002` in stage 7, then in stage 8 (`--rehearsal`) GS-ID-09's rehearsal crossing across the `v0003` activation and the GS-PE-RH sets in catalogue order with `v0003`.
- `harness/src/golden/compare.ts` compares each set with its replay output and writes `opt2/reports/parity.{json,md}`; a rehearsal crossing is compared with its own set under `rehearsal/` and fails on any unlisted difference.
- `harness/src/reporting/check-pin.ts` checks `sourceSha` in every file under this folder, and the `Source SHA:` line above.

## Files

- One file per scenario, `<scenario-id>.json`, where `<scenario-id>` is an `id` from `harness/golden/catalogue.yaml` matching `^GS-[A-Z]+(-RH)?-\d{2}$`. The GS-PE-RH sets are captured in the same pass, after all the others, as replay runs them.
- `rehearsal/<scenario-id>.json`: a rehearsal crossing's set. Each non-rehearsal HTTP scenario declaring `acrossTransition` (GS-ID-09) is captured a second time, after every other scenario and the browser flows and just before the GS-PE-RH sets, so the legacy state it sees is the one its stage 8 replay across `v0003` sees. Same shape as a scenario set.
- Readers open `<scenario-id>.json` and `rehearsal/<scenario-id>.json` for catalogue ids only, so no other file here is read as a set.
- Browser scenarios (GS-UI-*) are skipped by `capture.ts`. `harness/e2e/ui/interactions.e2e.ts` captures them (`OPT2_UI_PHASE=capture`) and writes each set here when it matches the set shape, else to `${OPT2_STATE_DIR}/golden/browser/<scenario-id>.legacy.json`. Its replay (`OPT2_UI_PHASE=replay`) writes `${OPT2_STATE_DIR}/golden/browser/<scenario-id>.json`, the record `compare.ts` classifies.
- The un-normalised exchanges of a capture go to `${OPT2_STATE_DIR}/golden/raw/<scenario-id>.json` (a crossing's to `golden/raw/rehearsal/`), never here.

## Set shape

```text
{sourceSha, scenarioId, capturedAt, origin: "legacy", tableVersion: null, fixtures, skipped?,
 steps: [{name, index, matrixKey?, routeKey, request{method, url, headers, body},
          response{status, headers, body | domModel | export, rawSha256}, normalised,
          expected?, decisionListRef?, exceptionId?, gap?, candidateIndex?}],
 sideEffects{mail[], rows{}, files[], transitions[]?}, generatedBy, generatedAt}
```

| Field | Content |
|---|---|
| `sourceSha` | `sha` of `opt2/source-pin.json` at capture time |
| `scenarioId` | Equals the file name stem |
| `capturedAt` | ISO-8601 capture time |
| `origin` | Always `legacy` |
| `tableVersion` | `null`, because capture bypasses the gateway |
| `fixtures` | `available` and `reason` from `${OPT2_STATE_DIR}/fixtures.json` |
| `skipped` | See [Skipped sets](#skipped-sets) |
| `steps[].name`, `index` | Catalogue step name and position. A `matrix` step stores one entry per combination under the same name, told apart by `matrixKey` (`<var>=<value>,…` with the declared values). Session log-ins declared under `sessions` are not stored; a scenario that compares its login lists it as steps, as GS-ID-01 does |
| `routeKey` | Route key of the request, from `@opt2/platform/legacy-compat` |
| `request` | As sent, with an origin-relative `url`. `body` is `{kind, value}` with kind `none`, `form`, `json` or `multipart`; multipart files are recorded by SHA-256 and size |
| `response` | `status`, normalised `headers`, `rawSha256` of the raw bytes, and exactly one of `body`, `domModel` or `export` |
| `response.body` | JSON or text. A JSON API body keeps legacy's envelope as served: `params` is absent under `suppressAPIParams`, and `data` is flattened when `useDataNamespace` is false [core/mura/client/api/json/v1/jsonApiUtility.cfc:1471-1511] |
| `response.domModel` | Cheerio DOM model of admin HTML |
| `response.export` | CSV cell values, a ZIP's files and directories by name, SHA-256 and size of their content (text files normalised, directories empty, nested archives expanded, each also listed empty as `<name>!/`; entry times and order not compared), or SHA-256 plus content type of any other download |
| `normalised` | Output of the one normaliser, `harness/src/golden/normalise/`, applying `harness/golden/normalise.yaml`. This is what `compare.ts` compares |
| `expected`, `decisionListRef`, `exceptionId` | `withheld`, `halted` or `gap`, with the decision-list or exceptions-list entry the step points to |
| `gap`, `candidateIndex` | A step no candidate request triggers deterministically, recorded as a halted `EX-GAP-*` entry in `opt2/exceptions-list.json`; the index of the candidate kept, which replay resends |
| `sideEffects` | `mail[]`: Mailpit To, From, Subject, text body and HTML text. `rows{}`: canonical rows per touched table. `files[]`: stored file variants by name, content type and SHA-256. `transitions[]`: ordered states per aggregate |
| `generatedBy`, `generatedAt` | Writer stamps |

## No secrets

- A request value that held a resolved credential is stored as `<secret>`; the catalogue keeps the `${secret:…}` placeholders. Credentials are resolved at run time from `MURA_ADMIN_PASSWORD`, `MASA_TEST_EDITOR_PASSWORD`, `MURA_APPRELOADKEY` and `${OPT2_STATE_DIR}/secrets/seed-credentials.json`.
- A stored `tusers.password` bcrypt hash that a resolved credential verifies is stored as `$<rev>$<cost>$<verifies:NAME>`, so a hash salted afresh on another run compares equal; others stay literal. In a scenario that compares rows, each account a `masa.users` seedRef selects resolves its password as `seed:<username>`.
- `Authorization` credentials, cookies and token values (`csrf_token`, `csrf_token_expires`, `access_token` and the other `tokens` of `normalise.yaml`) appear as `<token>`, in `request` and `response` as well as in `normalised`, except an `Authorization` credential that secret redaction already replaced whole, such as `Basic <secret>`, which stays `<secret>`. The CSRF fields come from forms such as `admin/core/views/clogin/main.cfm` (`renderCSRFTokens`, context `login`).
- A configured `MURA_APPRELOADKEY` is redacted wherever it stands as a URL query parameter, as the bare parameter or the `reload` value, whether or not a step resolves it, because every admin page renders it in the Reload Application link (`admin/common/layouts/includes/nav.cfm:338`). Other text equal to the key is kept. That link normalises to `/admin/?<token>&reload=<token>` (`tokens.valuelessParamsNamedBy` of `normalise.yaml`).
- Capture refuses to write a set in which a resolved secret remains, or the configured reload key remains as a URL query parameter, so the committed sets give gitleaks nothing to find.
- The legacy webroot (this checkout) and `${OPT2_STATE_DIR}`, which ACF error envelopes and rendered pages name, appear as `<webroot>` and `<state>` in `response` and `normalised` (`hostPaths` of `normalise.yaml`), so no set names a host directory.
- No runtime state is stored here. Runtime state lives in `${OPT2_STATE_DIR}`.

## Skipped sets

When `fixtures.json` reports the fixtures unavailable, every `fixtures: required` scenario (the people archive scenarios GS-PE-03 and GS-PE-RH-03) is written with `skipped: "skipped: fixtures unavailable"` and no steps, and the parity report marks it `skipped: fixtures unavailable`.
