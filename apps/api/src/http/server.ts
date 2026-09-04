import { config } from '../config.js';
import { migrate } from '../db/migrate.js';
import { buildApp } from './app.js';

const ran = await migrate();
if (ran.length > 0) console.log(`Applied migrations: ${ran.join(', ')}`);

const app = await buildApp();
await app.listen({ port: config.port, host: '0.0.0.0' });
