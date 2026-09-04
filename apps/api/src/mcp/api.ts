/**
 * The MCP server's only way to reach the storefront.
 *
 * Everything goes over the same HTTP API a human operator would use. No
 * database handle, no Razorpay client, no policy import — if a rule is going to
 * be enforced, it is enforced on the other side of this fetch, where it already
 * is. That is the whole point of the layer: an agent talking MCP and a curl on
 * the command line cannot reach different code paths.
 */

const DEFAULT_BASE_URL = 'http://localhost:3000';
const DEFAULT_TIMEOUT_MS = 15_000;

export function baseUrl(): string {
  return (process.env.STOREFRONT_API_URL ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
}

/** Whatever the storefront replied, plus the status so callers can branch. */
export interface ApiResponse {
  ok: boolean;
  status: number;
  body: unknown;
}

/**
 * A transport-level failure, shaped like every other error the tools return:
 * structured JSON the model can read and act on, never a thrown exception.
 */
export interface ApiFailure {
  error: 'STOREFRONT_UNREACHABLE';
  reason: string;
  base_url: string;
}

export function isFailure(r: ApiResponse | ApiFailure): r is ApiFailure {
  return (r as ApiFailure).error === 'STOREFRONT_UNREACHABLE';
}

async function request(
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
): Promise<ApiResponse | ApiFailure> {
  const url = `${baseUrl()}${path}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await res.text();
    let parsed: unknown = text;
    if (text.length > 0) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = { error: 'BAD_RESPONSE', reason: 'Storefront returned a non-JSON body' };
      }
    }
    return { ok: res.ok, status: res.status, body: parsed };
  } catch (err) {
    const reason =
      err instanceof Error && err.name === 'AbortError'
        ? `No response from the storefront within ${DEFAULT_TIMEOUT_MS}ms`
        : err instanceof Error
          ? err.message
          : String(err);
    return { error: 'STOREFRONT_UNREACHABLE', reason, base_url: baseUrl() };
  } finally {
    clearTimeout(timer);
  }
}

export function apiGet(path: string): Promise<ApiResponse | ApiFailure> {
  return request('GET', path);
}

export function apiPost(path: string, body: unknown): Promise<ApiResponse | ApiFailure> {
  return request('POST', path, body);
}

export function query(params: Record<string, string | number | undefined>): string {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined) qs.set(k, String(v));
  }
  const s = qs.toString();
  return s ? `?${s}` : '';
}
