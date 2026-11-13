# Golden sets

Source SHA: 696383140578f8dea3ece26f80cd7bfb370ddf0f

Outputs captured from legacy Masa that parity replay compares against. This README is the only authored file here; every set is written by the capture.

## Writer and readers

- `harness/src/golden/capture.ts` (`npm run golden:capture` in `harness/`) writes the sets during `harness/repro/test-all.sh` stage 5. It captures against legacy directly (`LEGACY_ORIGIN`, else `http://127.0.0.1:${PORT}`), after `opt2-ops drain-and-suspend` has suspended background work.
- Sets are committed after a capture run and never hand-edited. To change one, re-run the capture (`npm run golden:capture -- --only <scenario-id>`).
- `harness/src/golden/replay.ts` replays the same step scripts through the gateway (`OPT2_GATEWAY_URL`, else `http://127.0.0.1:8100`) in catalogue order, which is capture order: with `v0002` in stage 7, and the GS-PE-RH sets with `v0003` (`--rehearsal`) in stage 8.
- `harness/src/golden/compare.ts` compares each set with its replay output and writes `opt2/reports/parity.{json,md}`.
- `harness/src/reporting/check-pin.ts` checks `sourceSha` in every file under this folder, and the `Source SHA:` line above.

## Files

- One file per scenario, `<scenario-id>.json`, where `<scenario-id>` is an `id` from `harness/golden/catalogue.yaml` matching `^GS-[A-Z]+(-RH)?-\d{2}$`. The GS-PE-RH sets are captured in the same pass as the others.
- Readers open `<scenario-id>.json` for catalogue ids only, so no other file here is read as a set.
- Browser scenarios (GS-UI-*) are skipped by `capture.ts`. `harness/e2e/ui/interactions.e2e.ts` captures them (`OPT2_UI_PHASE=capture`) and writes each set here when it matches the set shape, else to `${OPT2_STATE_DIR}/golden/browser/<scenario-id>.legacy.json`. Its replay (`OPT2_UI_PHASE=replay`) writes `${OPT2_STATE_DIR}/golden/browser/<scenario-id>.json`, the record `compare.ts` classifies.
- The un-normalised exchanges of a capture go to `${OPT2_STATE_DIR}/golden/raw/<scenario-id>.json`, never here.

## Set shape

```text
{sourceSha, scenarioId, capturedAt, origin: "legacy", tableVersion: null, fixtures, skipped?,
 steps: [{name, index, matrixKey?, routeKey, request{method, url, headers, body},
          response{status, headers, body | domModel | export, rawSha256}, normalised,
          expected?, decisionListRef?, exceptionId?, gap?, candidateIndex?}],
 sideEffects{mail[], rows{}, tasks[], files[], transitions[]?}, generatedBy, generatedAt}
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
| `response.export` | CSV/XLSX cell values, PDF text per page, or SHA-256 plus content type of a download |
| `normalised` | Output of the one normaliser, `harness/src/golden/normalise/`, applying `harness/golden/normalise.yaml`. This is what `compare.ts` compares |
| `expected`, `decisionListRef`, `exceptionId` | `withheld`, `halted` or `gap`, with the decision-list or exceptions-list entry the step points to |
| `gap`, `candidateIndex` | A step no candidate request triggers deterministically, recorded as a halted `EX-GAP-*` entry in `opt2/exceptions-list.json`; the index of the candidate kept, which replay resends |
| `sideEffects` | `mail[]`: Mailpit To, From, Subject, text body and HTML text. `rows{}`: canonical rows per touched table. `tasks[]`: kind, target route and offset. `files[]`: stored file variants by name, content type and SHA-256. `transitions[]`: ordered states per aggregate |
| `generatedBy`, `generatedAt` | Writer stamps |

## No secrets

- A request value that held a resolved credential is stored as `<secret>`; the catalogue keeps the `${secret:…}` placeholders. Credentials are resolved at run time from `MURA_ADMIN_PASSWORD`, `MASA_TEST_EDITOR_PASSWORD`, `MURA_APPRELOADKEY` and `${OPT2_STATE_DIR}/secrets/seed-credentials.json`.
- `Authorization` credentials, cookies and token values (`csrf_token`, `csrf_token_expires`, `access_token` and the other `tokens` of `normalise.yaml`) appear only as `<token>`, in `request` and `response` as well as in `normalised`. The CSRF fields come from forms such as `admin/core/views/clogin/main.cfm` (`renderCSRFTokens`, context `login`).
- Capture refuses to write a set in which a resolved secret remains, so the committed sets give gitleaks nothing to find.
- No runtime state is stored here. Runtime state lives in `${OPT2_STATE_DIR}`.

## Skipped sets

When `fixtures.json` reports the fixtures unavailable, every `fixtures: required` scenario (the synthetic modules and the seams) is written with `skipped: "skipped: fixtures unavailable"` and no steps, and the parity report marks it `skipped: fixtures unavailable`.
