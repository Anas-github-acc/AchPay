import { apiGet, ApiError } from '../../lib/api';
import { MandatesView, type MandatesResponse } from './mandates-view';
import { headers } from 'next/headers';

export const dynamic = 'force-dynamic';

export default async function MandatesPage() {
  let data: MandatesResponse | null = null;
  let error: string | null = null;
  try {
    const incoming = await headers();
    data = await apiGet<MandatesResponse>('/mandates?limit=50', {
      cookie: incoming.get('cookie') ?? '',
    });
  } catch (err) {
    error = err instanceof ApiError ? err.message : String(err);
  }

  const mandates = data?.mandates ?? [];

  return <MandatesView initialMandates={mandates} initialError={error} />;
}
