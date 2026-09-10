import { Redis } from 'ioredis';
import { config } from './config.js';

export const redis = new Redis(config.redisUrl, {
  keyPrefix: config.redisPrefix,
  maxRetriesPerRequest: 2,
  lazyConnect: false,
});

export async function closeRedis(): Promise<void> {
  await redis.quit();
}
