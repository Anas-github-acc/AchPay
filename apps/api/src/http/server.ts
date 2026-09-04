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
