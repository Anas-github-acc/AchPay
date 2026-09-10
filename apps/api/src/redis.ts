import { Redis as IORedis } from 'ioredis';
import { config } from './config.js';

export interface RedisLike {
  set(key: string, value: string, options: { ex: number }): Promise<unknown>;
  get(key: string): Promise<string | null>;
  del(key: string): Promise<number>;
  ping(): Promise<unknown>;
}

interface RedisConnection extends RedisLike {
  close(): Promise<void>;
  disconnect(): void;
}

class UpstashRestRedis implements RedisConnection {
  constructor(
    private readonly url: string,
    private readonly token: string,
  ) {}

  private key(key: string): string {
    return `${config.redisPrefix}${key}`;
  }

  private async command<T>(command: string[]): Promise<T> {
    const response = await fetch(this.url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(command),
    });
    const body = (await response.json()) as { result?: T; error?: string };
    if (!response.ok || body.error !== undefined) {
      throw new Error(`Upstash Redis error: ${body.error ?? response.statusText}`);
    }
    return body.result as T;
  }

  async set(key: string, value: string, options: { ex: number }): Promise<unknown> {
    return this.command(['SET', this.key(key), value, 'EX', String(options.ex)]);
  }

  async get(key: string): Promise<string | null> {
    return this.command<string | null>(['GET', this.key(key)]);
  }

  async del(key: string): Promise<number> {
    return this.command<number>(['DEL', this.key(key)]);
  }

  async ping(): Promise<unknown> {
    return this.command(['PING']);
  }

  async close(): Promise<void> {
    // REST connections are stateless and need no shutdown operation.
  }

  disconnect(): void {}
}

class LocalRedis implements RedisConnection {
  constructor(private readonly client: IORedis) {}

  private key(key: string): string {
    return `${config.redisPrefix}${key}`;
  }

  async set(key: string, value: string, options: { ex: number }): Promise<unknown> {
    return this.client.set(this.key(key), value, 'EX', options.ex);
  }

  async get(key: string): Promise<string | null> {
    return this.client.get(this.key(key));
  }

  async del(key: string): Promise<number> {
    return this.client.del(this.key(key));
  }

  async ping(): Promise<unknown> {
    return this.client.ping();
  }

  async close(): Promise<void> {
    await this.client.quit();
  }

  disconnect(): void {
    this.client.disconnect();
  }
}

const hasUpstashUrl = Boolean(config.upstashRedisRestUrl);
const hasUpstashToken = Boolean(config.upstashRedisRestToken);
if (hasUpstashUrl !== hasUpstashToken) {
  throw new Error('UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN must be configured together');
}
const hasUpstash = hasUpstashUrl && hasUpstashToken;

export const redis: RedisConnection = hasUpstash
  ? new UpstashRestRedis(config.upstashRedisRestUrl!, config.upstashRedisRestToken!)
  : new LocalRedis(
      new IORedis(config.redisUrl ?? 'redis://localhost:56379', {
        maxRetriesPerRequest: 2,
        lazyConnect: false,
      }),
    );

export async function closeRedis(): Promise<void> {
  await redis.close();
}
