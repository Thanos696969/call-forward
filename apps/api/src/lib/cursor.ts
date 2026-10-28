import { badRequest } from './errors';

/** Opaque keyset cursor: base64url(JSON [sortKey, id]). */
export function encodeCursor(sortKey: string, id: string): string {
  return Buffer.from(JSON.stringify([sortKey, id]), 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string): { sortKey: string; id: string } {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (
      Array.isArray(parsed) &&
      parsed.length === 2 &&
      typeof parsed[0] === 'string' &&
      typeof parsed[1] === 'string'
    ) {
      return { sortKey: parsed[0], id: parsed[1] };
    }
  } catch {
    // fall through to the error below
  }
  throw badRequest('invalid_cursor', 'The pagination cursor is invalid');
}
