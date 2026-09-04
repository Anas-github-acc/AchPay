import { config } from '../config.js';
import { migrate } from '../db/migrate.js';
import { buildApp } from './app.js';
import { startReclaimLoop } from '../payments/reclaim-loop.js';

const ran = await migrate();
if (ran.length > 0) console.log(`Applied migrations: ${ran.join(', ')}`);

const app = await buildApp();

// Gives back headroom held by payments that stopped happening — chiefly a
// mandate order nobody authorised, which sends no webhook of any kind.
startReclaimLoop(app.adapter);

await app.listen({ port: config.port, host: '0.0.0.0' });

// The one URL a remote MCP client needs, printed rather than guessed at. It is
// the public origin, not the bind address, because the point of it is to be
// pasted into something that is not on this machine.
if (config.mcpHttpToken === undefined) {
  console.log('MCP over HTTP is off. Set MCP_HTTP_TOKEN to mount /mcp.');
} else {
  // Origin only: PUBLIC_BASE_URL is allowed to carry a path (it is what the
  // payment provider is pointed at), and /mcp hangs off the root.
  const origin = new URL(config.publicBaseUrl).origin;
  console.log(`MCP over HTTP: ${origin}/mcp?key=${config.mcpHttpToken}`);
}
