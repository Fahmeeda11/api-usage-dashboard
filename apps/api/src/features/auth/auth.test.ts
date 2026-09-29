import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import supertest from 'supertest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { clearTestDb, extractCookie, signupTestUser, startTestDb, stopTestDb } from '../../test/helpers.js';
import { RefreshToken } from '@usage/db';

let app: Express;

beforeAll(async () => {
  await startTestDb();
  app = createApp();
});

afterAll(stopTestDb);
beforeEach(clearTestDb);

const VALID_PASSWORD = 'correct-horse-battery-staple';

describe('POST /auth/signup', () => {
  it('creates a user and returns an access token plus a refresh cookie', async () => {
    const res = await supertest(app)
      .post('/auth/signup')
      .send({ name: 'Ada', email: 'ada@example.test', password: VALID_PASSWORD })
      .expect(201);

    expect(res.body.user.email).toBe('ada@example.test');
    expect(res.body.accessToken).toBeTypeOf('string');
    expect(res.body.expiresIn).toBe(900);

    const cookie = extractCookie(res.headers['set-cookie'], 'usage_refresh');
    expect(cookie).toBeTruthy();
  });

  it('never returns the password hash', async () => {
    const res = await supertest(app)
      .post('/auth/signup')
      .send({ name: 'Ada', email: 'ada2@example.test', password: VALID_PASSWORD })
      .expect(201);

    expect(JSON.stringify(res.body)).not.toContain('argon2');
    expect(res.body.user).not.toHaveProperty('passwordHash');
  });

  it('marks the refresh cookie httpOnly so script cannot read it', async () => {
    const res = await supertest(app)
      .post('/auth/signup')
      .send({ name: 'Ada', email: 'ada3@example.test', password: VALID_PASSWORD })
      .expect(201);

    const raw = (res.headers['set-cookie'] as unknown as string[]).find((c) =>
      c.startsWith('usage_refresh='),
    );
    expect(raw).toMatch(/HttpOnly/i);
    expect(raw).toMatch(/SameSite=Lax/i);
    expect(raw).toMatch(/Path=\/auth/i);
  });

  it('rejects a short password with a field-level error', async () => {
    const res = await supertest(app)
      .post('/auth/signup')
      .send({ name: 'Ada', email: 'ada4@example.test', password: 'short' })
      .expect(422);

    expect(res.body.error.code).toBe('VALIDATION_FAILED');
    expect(res.body.error.fields.password).toMatch(/at least 10/i);
  });

  it('rejects a duplicate email', async () => {
    await supertest(app)
      .post('/auth/signup')
      .send({ name: 'Ada', email: 'dupe@example.test', password: VALID_PASSWORD })
      .expect(201);

    const res = await supertest(app)
      .post('/auth/signup')
      .send({ name: 'Other', email: 'dupe@example.test', password: VALID_PASSWORD })
      .expect(409);

    expect(res.body.error.code).toBe('EMAIL_TAKEN');
  });

  it('treats email as case-insensitive', async () => {
    await supertest(app)
      .post('/auth/signup')
      .send({ name: 'Ada', email: 'Case@Example.test', password: VALID_PASSWORD })
      .expect(201);

    await supertest(app)
      .post('/auth/signup')
      .send({ name: 'Other', email: 'case@example.TEST', password: VALID_PASSWORD })
      .expect(409);
  });

  it('strips unknown fields instead of passing them to the model', async () => {
    // Mass-assignment guard: validateBody replaces req.body with the parsed
    // result, so an injected field cannot reach User.create.
    const res = await supertest(app)
      .post('/auth/signup')
      .send({
        name: 'Ada',
        email: 'strip@example.test',
        password: VALID_PASSWORD,
        role: 'admin',
        isAdmin: true,
      })
      .expect(201);

    expect(res.body.user).not.toHaveProperty('role');
    expect(res.body.user).not.toHaveProperty('isAdmin');
  });
});

describe('POST /auth/login', () => {
  beforeEach(async () => {
    await supertest(app)
      .post('/auth/signup')
      .send({ name: 'Ada', email: 'login@example.test', password: VALID_PASSWORD })
      .expect(201);
  });

  it('succeeds with the right password', async () => {
    const res = await supertest(app)
      .post('/auth/login')
      .send({ email: 'login@example.test', password: VALID_PASSWORD })
      .expect(200);

    expect(res.body.accessToken).toBeTypeOf('string');
    expect(extractCookie(res.headers['set-cookie'], 'usage_refresh')).toBeTruthy();
  });

  it('rejects the wrong password', async () => {
    const res = await supertest(app)
      .post('/auth/login')
      .send({ email: 'login@example.test', password: 'wrong-password-entirely' })
      .expect(401);

    expect(res.body.error.code).toBe('INVALID_CREDENTIALS');
  });

  /**
   * User enumeration guard. An attacker must not be able to learn which
   * addresses have accounts by comparing responses, so the status, the code and
   * the message all have to match exactly between these two cases.
   */
  it('gives an identical response for a missing account and a wrong password', async () => {
    const missing = await supertest(app)
      .post('/auth/login')
      .send({ email: 'nobody@example.test', password: VALID_PASSWORD })
      .expect(401);

    const wrongPassword = await supertest(app)
      .post('/auth/login')
      .send({ email: 'login@example.test', password: 'wrong-password-entirely' })
      .expect(401);

    expect(missing.body).toEqual(wrongPassword.body);
  });
});

describe('POST /auth/refresh', () => {
  it('exchanges the cookie for a new access token', async () => {
    const user = await signupTestUser(app);

    const res = await supertest(app)
      .post('/auth/refresh')
      .set('Cookie', user.refreshCookie)
      .expect(200);

    expect(res.body.accessToken).toBeTypeOf('string');
    expect(res.body.user.id).toBe(user.userId);
  });

  it('rotates the token, issuing a different one each time', async () => {
    const user = await signupTestUser(app);

    const res = await supertest(app)
      .post('/auth/refresh')
      .set('Cookie', user.refreshCookie)
      .expect(200);

    const rotated = extractCookie(res.headers['set-cookie'], 'usage_refresh');
    expect(rotated).toBeTruthy();
    expect(rotated).not.toBe(user.refreshCookie);
  });

  it('supports a chain of rotations', async () => {
    const user = await signupTestUser(app);
    let cookie = user.refreshCookie;

    for (let i = 0; i < 5; i++) {
      const res = await supertest(app).post('/auth/refresh').set('Cookie', cookie).expect(200);
      const next = extractCookie(res.headers['set-cookie'], 'usage_refresh');
      expect(next).toBeTruthy();
      cookie = next as string;
    }
  });

  it('rejects a request with no cookie', async () => {
    const res = await supertest(app).post('/auth/refresh').expect(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('rejects a garbage cookie', async () => {
    await supertest(app)
      .post('/auth/refresh')
      .set('Cookie', 'usage_refresh=not-a-real-token')
      .expect(401);
  });

  /* ---------------------------------------------------------------------- */

  /**
   * The security property this whole design exists for.
   *
   * Scenario: an attacker copies the refresh cookie. The real user refreshes
   * first, so the stolen token is now spent. When the attacker presents it, the
   * server sees an already-used token, cannot tell which party is legitimate,
   * and revokes the entire family - ending both sessions. The attacker is locked
   * out, and the real user is forced to sign in again, which is the correct
   * trade.
   */
  it('detects reuse of a spent token and revokes the whole family', async () => {
    const user = await signupTestUser(app);
    const stolen = user.refreshCookie;

    // Legitimate user rotates first.
    const legit = await supertest(app).post('/auth/refresh').set('Cookie', stolen).expect(200);
    const legitCookie = extractCookie(legit.headers['set-cookie'], 'usage_refresh') as string;

    // Attacker replays the old cookie.
    const reuse = await supertest(app).post('/auth/refresh').set('Cookie', stolen).expect(401);
    expect(reuse.body.error.code).toBe('TOKEN_REUSED');

    // And the legitimate user's freshly-rotated token is dead too.
    await supertest(app).post('/auth/refresh').set('Cookie', legitCookie).expect(401);

    const live = await RefreshToken.countDocuments({ revokedAt: null });
    expect(live).toBe(0);
  });

  it('clears the cookie when refresh fails, so the client stops retrying', async () => {
    const res = await supertest(app)
      .post('/auth/refresh')
      .set('Cookie', 'usage_refresh=not-a-real-token')
      .expect(401);

    const raw = (res.headers['set-cookie'] as unknown as string[] | undefined)?.find((c) =>
      c.startsWith('usage_refresh='),
    );
    expect(raw).toBeDefined();
    expect(raw).toMatch(/usage_refresh=;/);
  });
});

describe('POST /auth/logout', () => {
  it('revokes the session and clears the cookie', async () => {
    const user = await signupTestUser(app);

    await supertest(app).post('/auth/logout').set('Cookie', user.refreshCookie).expect(204);

    // The cookie no longer buys a new access token.
    await supertest(app).post('/auth/refresh').set('Cookie', user.refreshCookie).expect(401);
  });

  it('succeeds even with no session, because logging out of nothing is fine', async () => {
    await supertest(app).post('/auth/logout').expect(204);
  });
});

describe('GET /auth/me', () => {
  it('returns the signed-in user', async () => {
    const user = await signupTestUser(app);

    const res = await supertest(app)
      .get('/auth/me')
      .set('Authorization', `Bearer ${user.accessToken}`)
      .expect(200);

    expect(res.body.user.id).toBe(user.userId);
  });

  it('rejects a missing token', async () => {
    await supertest(app).get('/auth/me').expect(401);
  });

  it('rejects a malformed Authorization header', async () => {
    await supertest(app).get('/auth/me').set('Authorization', 'Bearer').expect(401);
    await supertest(app).get('/auth/me').set('Authorization', 'Basic abc123').expect(401);
  });

  it('rejects a token signed with the wrong secret', async () => {
    // Forged with a different key: signature verification must reject it.
    const forged =
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.' +
      'eyJzdWIiOiI2NTAwMDAwMDAwMDAwMDAwMDAwMDAwMDAiLCJlbWFpbCI6ImFAYi5jIn0.' +
      'bm90LWEtdmFsaWQtc2lnbmF0dXJl';
    await supertest(app).get('/auth/me').set('Authorization', `Bearer ${forged}`).expect(401);
  });
});

describe('error envelope', () => {
  /**
   * The web client parses every error body with apiErrorSchema. If any endpoint
   * can return a differently-shaped body - including Express's default HTML 404
   * page - the client's error handler throws and the user gets a blank screen
   * instead of a message.
   */
  it('uses the shared error shape for unmatched routes', async () => {
    const res = await supertest(app).get('/no-such-route').expect(404);
    expect(res.body.error).toMatchObject({ code: 'NOT_FOUND', message: expect.any(String) });
  });

  it('uses the shared error shape for malformed JSON', async () => {
    const res = await supertest(app)
      .post('/auth/login')
      .set('Content-Type', 'application/json')
      .send('{"email": ')
      .expect(400);

    expect(res.body.error.code).toBe('VALIDATION_FAILED');
  });
});
