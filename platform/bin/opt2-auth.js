#!/usr/bin/env node
// `opt2-auth` bin: runs the CLI that `npm run build` compiles into dist/.
import { main } from '../dist/auth/cli.js';

process.exit(await main(process.argv.slice(2)));
