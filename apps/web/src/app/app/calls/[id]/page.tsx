import type { Metadata } from 'next';
import { CallDetail } from './call-detail';

export const metadata: Metadata = { title: 'Call' };

export default async function CallPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <CallDetail id={id} />;
}
