import { MandatesView } from './mandates-view';
import { requireWebAuth } from '../../lib/auth';

export const dynamic = 'force-dynamic';

export default async function MandatesPage() {
  await requireWebAuth('/mandates');
  return <MandatesView initialMandates={[]} initialError={null} />;
}
