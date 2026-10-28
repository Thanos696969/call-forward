import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashToken } from '@relay/core/server';
import { Client, json, signUp, startHarness, uniqueEmail, type Harness } from '../harness';

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
});
afterAll(async () => {
  await h.close();
});

describe('auth', () => {
  it('registers, logs out, logs back in and rotates the session', async () => {
    const { client, email } = await signUp(h.app, 'Auth Co');
    const firstToken = client.cookie('relay_session');
    expect(firstToken).toBeTruthy();
    const [stored] = await h.deps.sql<
      { id: string }[]
    >`select id from sessions where id = ${hashToken(firstToken!)}`;
    expect(stored?.id).toBe(hashToken(firstToken!)); // only the hash is stored

    expect((await client.post('/api/v1/auth/logout')).statusCode).toBe(200);
    expect((await client.get('/api/v1/me')).statusCode).toBe(401);

    const bad = await client.post('/api/v1/auth/login', { email, password: 'wrong-password' });
    expect(bad.statusCode).toBe(401);
    expect(json<{ error: { code: string } }>(bad).error.code).toBe('invalid_credentials');
    const unknown = await client.post('/api/v1/auth/login', {
      email: uniqueEmail(),
      password: 'whatever-123',
    });
    expect(unknown.statusCode).toBe(401);

    const good = await client.post('/api/v1/auth/login', {
      email: email.toUpperCase(),
      password: 'correct-horse-battery',
    });
    expect(good.statusCode).toBe(200);
    expect(client.cookie('relay_session')).not.toBe(firstToken);
    expect((await client.get('/api/v1/me')).statusCode).toBe(200);
  });

  it('sets a hardened session cookie', async () => {
    const c = new Client(h.app);
    const res = await c.post('/api/v1/auth/register', {
      orgName: 'Cookie Co',
      email: uniqueEmail(),
      password: 'correct-horse-battery',
    });
    const cookie = res.cookies.find((x) => x.name === 'relay_session');
    expect(cookie).toMatchObject({ httpOnly: true, sameSite: 'Lax', path: '/' });
    expect(cookie?.expires).toBeInstanceOf(Date);
  });

  it('rejects duplicate emails, weak passwords and unknown fields', async () => {
    const { email } = await signUp(h.app);
    const c = new Client(h.app);
    const dup = await c.post('/api/v1/auth/register', {
      orgName: 'Dup',
      email,
      password: 'correct-horse-battery',
    });
    expect(dup.statusCode).toBe(409);
    expect(
      (
        await c.post('/api/v1/auth/register', {
          orgName: 'Weak',
          email: uniqueEmail(),
          password: 'short',
        })
      ).statusCode,
    ).toBe(422);
    const extra = await c.post('/api/v1/auth/register', {
      orgName: 'Extra',
      email: uniqueEmail(),
      password: 'correct-horse-battery',
      role: 'admin',
    });
    expect(extra.statusCode).toBe(422);
  });

  it('enforces CSRF on state-changing requests', async () => {
    const { client } = await signUp(h.app);
    const res = await client.request('PATCH', '/api/v1/org', { name: 'No Token' }, { csrf: false });
    expect(res.statusCode).toBe(403);
    expect(json<{ error: { code: string } }>(res).error.code).toBe('csrf_failed');
    expect((await client.patch('/api/v1/org', { name: 'With Token' })).statusCode).toBe(200);
  });

  it('updates the organisation and validates the timezone', async () => {
    const { client } = await signUp(h.app);
    expect((await client.patch('/api/v1/org', { timezone: 'Mars/Olympus' })).statusCode).toBe(422);
    const ok = await client.patch('/api/v1/org', { timezone: 'Asia/Kolkata', name: 'Renamed' });
    expect(json<{ data: { timezone: string; name: string } }>(ok).data).toMatchObject({
      timezone: 'Asia/Kolkata',
      name: 'Renamed',
    });
  });

  it('resets a password by email link and signs out every session', async () => {
    const { client, email } = await signUp(h.app);
    const anon = new Client(h.app);
    expect((await anon.post('/api/v1/auth/forgot-password', { email })).statusCode).toBe(200);
    expect(
      (await anon.post('/api/v1/auth/forgot-password', { email: uniqueEmail() })).statusCode,
    ).toBe(200);
    const mail = h.mailer.sent.find((m) => m.to === email);
    const token = mail
      ? new URL(/https?:\/\/\S+/.exec(mail.text)![0]).searchParams.get('token')
      : null;
    expect(token).toBeTruthy();

    expect(
      (await anon.post('/api/v1/auth/reset-password', { token, password: 'brand-new-password' }))
        .statusCode,
    ).toBe(200);
    expect(
      (await anon.post('/api/v1/auth/reset-password', { token, password: 'again-new-password' }))
        .statusCode,
    ).toBe(400);
    expect((await client.get('/api/v1/me')).statusCode).toBe(401);
    expect(
      (await anon.post('/api/v1/auth/login', { email, password: 'brand-new-password' })).statusCode,
    ).toBe(200);
  });
});

describe('rate limits', () => {
  it('limits login attempts to 5 per minute per IP', async () => {
    const limited = await (await import('../harness')).startHarness({ RATE_LIMIT_ENABLED: 'true' });
    try {
      await limited.deps.redis.flushdb();
      const c = new Client(limited.app);
      const codes: number[] = [];
      for (let i = 0; i < 6; i++) {
        codes.push(
          (await c.post('/api/v1/auth/login', { email: uniqueEmail(), password: 'nope-nope-nope' }))
            .statusCode,
        );
      }
      expect(codes.slice(0, 5)).toEqual([401, 401, 401, 401, 401]);
      expect(codes[5]).toBe(429);
    } finally {
      await limited.close();
    }
  });
});
