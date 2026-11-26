#!/usr/bin/env node
// `opt2-outbox` bin: runs the CLI that `npm run build` compiles into dist/.
import { main } from '../dist/outbox/cli.js';

process.exit(await main());
