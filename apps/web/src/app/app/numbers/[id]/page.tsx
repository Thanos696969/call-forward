import type { Metadata } from 'next';
import { NumberDetail } from './number-detail';

export const metadata: Metadata = { title: 'Number' };

export default async function NumberPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <NumberDetail id={id} />;
}
