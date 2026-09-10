import type { Redis } from 'ioredis';
import { canonicalJson } from '../lib/canonical.js';
import type { SignedQuote } from './types.js';

/**
 * Quotes live in Redis keyed by quote_id with a TTL.
 *
 * The TTL is the quote lifetime plus a grace window: an expired-but-recent
 * quote is still retrievable, so replaying one gets QUOTE_EXPIRED (an honest
 * answer) rather than QUOTE_NOT_FOUND (which reads like a server bug).
 */
export const EXPIRY_GRACE_SECONDS = 300;

export class QuoteStore {
  constructor(
    private readonly redis: Redis,
    private readonly ttlSeconds: number,
  ) {}

  private key(quoteId: string): string {
    return `quote:${quoteId}`;
  }

  async put(quote: SignedQuote): Promise<void> {
    await this.redis.set(
      this.key(quote.quote_id),
      canonicalJson(quote),
      'EX',
      this.ttlSeconds + EXPIRY_GRACE_SECONDS,
    );
  }

  async get(quoteId: string): Promise<SignedQuote | undefined> {
    const raw = await this.redis.get(this.key(quoteId));
    return raw ? (JSON.parse(raw) as SignedQuote) : undefined;
  }

  async delete(quoteId: string): Promise<void> {
    await this.redis.del(this.key(quoteId));
  }
}
