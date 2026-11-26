// Production entry of the web process (`node server.ts`), in place of `next start`.
import { runWebServer } from './src/server/start.ts';

await runWebServer();
