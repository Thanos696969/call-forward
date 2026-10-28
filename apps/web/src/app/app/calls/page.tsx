import { Suspense } from 'react';
import type { Metadata } from 'next';
import { CallsView } from './calls-view';

export const metadata: Metadata = { title: 'Call log' };

export default function CallsPage() {
  return (
    <Suspense>
      <CallsView />
    </Suspense>
  );
}
