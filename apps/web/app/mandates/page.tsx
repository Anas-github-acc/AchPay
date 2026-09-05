import { apiGet, ApiError } from '../../lib/api';
import { MandatesView, type MandatesResponse } from './mandates-view';

export const dynamic = 'force-dynamic';

export default async function MandatesPage() {
  let data: MandatesResponse | null = null;
  let error: string | null = null;
  try {
    data = await apiGet<MandatesResponse>('/mandates?limit=50');
  } catch (err) {
    error = err instanceof ApiError ? err.message : String(err);
  }

  const mandates = data?.mandates ?? [];

  return <MandatesView initialMandates={mandates} initialError={error} />;
}

