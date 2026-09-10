import Fastify from 'fastify';
import { buildApp } from './http/app.js';

// Vercel's Fastify detector expects the recognized entrypoint
// itself to import the fastify package.
void Fastify;

const app = await buildApp();

await app.listen({
  port: Number(process.env.PORT ?? 3000),
  host: '0.0.0.0',
});
