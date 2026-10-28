import { type Algorithm, hash, verify } from '@node-rs/argon2';

// `Algorithm` is an ambient const enum (unusable under isolatedModules); Argon2id = 2.
const ARGON2ID = 2 as Algorithm;

/** Argon2id: 64 MiB memory, 3 iterations, parallelism 1. */
export const ARGON2_OPTIONS = {
  algorithm: ARGON2ID,
  memoryCost: 65536,
  timeCost: 3,
  parallelism: 1,
} as const;

export function hashPassword(password: string): Promise<string> {
  return hash(password, ARGON2_OPTIONS);
}

/** Constant-time verification (performed inside argon2). Never throws on malformed hashes. */
export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  try {
    return await verify(passwordHash, password);
  } catch {
    return false;
  }
}
