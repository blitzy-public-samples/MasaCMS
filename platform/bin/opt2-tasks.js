#!/usr/bin/env node
// `opt2-tasks` bin: runs the CLI that `npm run build` compiles into dist/.
import { main } from '../dist/tasks/cli.js';

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
