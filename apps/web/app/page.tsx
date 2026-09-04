import { redirect } from 'next/navigation';

/** The attack log is the front door. Everything else supports the argument it makes. */
export default function Home() {
  redirect('/security');
}
