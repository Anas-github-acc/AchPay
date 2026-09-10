import { buildApp } from './http/app.js';

// Vercel discovers this conventional Fastify entrypoint and adapts the
// listener into a Function. Keep database migrations and local-only background
// loops in http/server.ts; they are not part of the serverless entrypoint.
const app = await buildApp();
await app.listen({ port: 3000 });
