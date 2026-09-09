import type { IncomingMessage, ServerResponse } from 'node:http';
import { buildApp } from './app.js';

let appPromise: ReturnType<typeof buildApp> | undefined;

/** Vercel entrypoint. The persistent local server remains in server.ts. */
export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  appPromise ??= buildApp();
  const app = await appPromise;
  await app.ready();
  app.server.emit('request', req, res);
}
