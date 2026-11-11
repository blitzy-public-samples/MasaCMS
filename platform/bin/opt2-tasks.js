#!/usr/bin/env node
// `opt2-tasks` bin: runs the CLI that `npm run build` compiles into dist/.
import { emitDiagnostic } from '../dist/logging/index.js';
import { safeErrorMessage } from '../dist/logging/safe-error.js';
import { main } from '../dist/tasks/cli.js';

main().then(
  (code) => process.exit(code),
  (err) => {
    emitDiagnostic('OPT2_TASKS', `opt2-tasks failed: ${safeErrorMessage(err)}`, err);
    // A native warning prints on the next tick, so exiting now would drop it.
    setImmediate(() => process.exit(1));
  },
);
