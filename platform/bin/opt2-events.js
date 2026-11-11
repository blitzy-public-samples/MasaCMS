#!/usr/bin/env node
// `opt2-events` bin: runs the CLI that `npm run build` compiles into dist/.
import { main } from '../dist/events/cli.js';

process.exit(await main());
