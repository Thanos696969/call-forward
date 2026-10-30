import { handler } from '@/server/api-route';

// Served by the Relay API (embedded on Vercel, proxied to API_URL locally).
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export { handler as GET, handler as POST, handler as PUT, handler as PATCH, handler as DELETE };
export { handler as OPTIONS, handler as HEAD };
