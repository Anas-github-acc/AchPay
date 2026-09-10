import Fastify from 'fastify';
export { default } from './http/vercel.js';

// Vercel's Fastify detector expects the recognized entrypoint
// itself to import the fastify package.
void Fastify;
