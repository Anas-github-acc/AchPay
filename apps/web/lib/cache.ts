const CACHE_PREFIX = 'achpay:data:';

export function readCached<T>(key: string): T | null {
  if (typeof window === 'undefined') return null;
  try {
    const value = window.sessionStorage.getItem(`${CACHE_PREFIX}${key}`);
    return value ? JSON.parse(value) as T : null;
  } catch { return null; }
}

export function writeCached<T>(key: string, value: T): void {
  if (typeof window === 'undefined') return;
  try { window.sessionStorage.setItem(`${CACHE_PREFIX}${key}`, JSON.stringify(value)); } catch { /* storage is optional */ }
}
