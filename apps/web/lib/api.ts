/**
 * The dashboard's only way to reach anything.
 *
 * There is no business logic on this side of the wire: every number on every
 * page is one the API already computed. Client components call the relative
 * `/api/...` path, which next.config.mjs rewrites onto the API so the browser
 * makes a same-origin request and nothing needs CORS. Server components skip
 * the rewrite and call the API directly.
 */

const INTERNAL_BASE = process.env.API_BASE_URL ?? 'http://localhost:3000';

export function apiUrl(path: string): string {
  const suffix = path.startsWith('/') ? path : `/${path}`;
  return typeof window === 'undefined' ? `${INTERNAL_BASE}${suffix}` : `/api${suffix}`;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** Always uncached: a dashboard that shows a stale ledger is worse than none. */
export async function apiGet<T>(path: string, headers?: HeadersInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(apiUrl(path), { cache: 'no-store', headers });
  } catch (err) {
    throw new ApiError(
      `Cannot reach the API at ${INTERNAL_BASE}. Is \`pnpm dev\` running? (${
        err instanceof Error ? err.message : String(err)
      })`,
    );
  }
  if (!response.ok) {
    throw new ApiError(`${path} returned ${response.status} ${response.statusText}`, response.status);
  }
  return (await response.json()) as T;
}

export async function apiPost<T>(path: string, body?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(apiUrl(path), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    throw new ApiError(
      `Cannot reach the API at ${INTERNAL_BASE}. Is \`pnpm dev\` running? (${
        err instanceof Error ? err.message : String(err)
      })`,
    );
  }
  if (!response.ok) {
    let errorDetail = `${path} returned ${response.status} ${response.statusText}`;
    try {
      const data = (await response.json()) as { reason?: string; error?: string };
      if (data?.reason) {
        errorDetail = data.reason;
      } else if (data?.error) {
        errorDetail = data.error;
      }
    } catch {
      // response might not be JSON
    }
    throw new ApiError(errorDetail, response.status);
  }
  return (await response.json()) as T;
}
