/**
 * Integration-test harness.
 *
 * Tests run against a real MongoDB (mongodb-memory-server), not a mock. Mocking
 * the ODM would mean the tests pass while the actual queries are wrong - unique
 * indexes, TTL behaviour, $inc guards and cast errors are precisely the things
 * that break in production and precisely the things a mock cannot tell you
 * about.
 */

import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import supertest from 'supertest';
import type { Express } from 'express';

let memoryServer: MongoMemoryServer | null = null;

/** Boot an in-memory Mongo and connect mongoose to it. Call in beforeAll. */
export async function startTestDb(): Promise<string> {
  memoryServer = await MongoMemoryServer.create();
  const uri = memoryServer.getUri();
  await mongoose.connect(uri);
  // Build the indexes the models declare - the unique constraints on email and
  // dedupeKey are under test, and without this they simply would not exist.
  await Promise.all(Object.values(mongoose.models).map((m) => m.syncIndexes()));
  return uri;
}

export async function stopTestDb(): Promise<void> {
  await mongoose.disconnect();
  await memoryServer?.stop();
  memoryServer = null;
}

/** Wipe every collection between tests, keeping indexes intact. */
export async function clearTestDb(): Promise<void> {
  const { collections } = mongoose.connection;
  await Promise.all(Object.values(collections).map((c) => c.deleteMany({})));
}

/* -------------------------------------------------------------------------- */

export interface SignedUpUser {
  accessToken: string;
  refreshCookie: string;
  userId: string;
  email: string;
}

/** Pull one named cookie out of a set-cookie header array. */
export function extractCookie(
  setCookieHeader: string[] | string | undefined,
  name: string,
): string | null {
  if (!setCookieHeader) return null;
  const list = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader];
  const match = list.find((c) => c.startsWith(`${name}=`));
  if (!match) return null;
  return match.split(';')[0] ?? null;
}

let userCounter = 0;

/** Create a user and return usable credentials. The workhorse of these tests. */
export async function signupTestUser(
  app: Express,
  overrides: Partial<{ name: string; email: string; password: string }> = {},
): Promise<SignedUpUser> {
  userCounter += 1;
  const payload = {
    name: overrides.name ?? `Test User ${userCounter}`,
    email: overrides.email ?? `user${userCounter}.${Date.now()}@example.test`,
    password: overrides.password ?? 'correct-horse-battery-staple',
  };

  const res = await supertest(app).post('/auth/signup').send(payload).expect(201);
  const cookie = extractCookie(res.headers['set-cookie'], 'usage_refresh');

  if (!cookie) throw new Error('signup did not set a refresh cookie');

  return {
    accessToken: res.body.accessToken,
    refreshCookie: cookie,
    userId: res.body.user.id,
    email: payload.email,
  };
}

/** supertest agent with the Authorization header already attached. */
export function authed(app: Express, user: SignedUpUser) {
  return {
    get: (url: string) => supertest(app).get(url).set('Authorization', `Bearer ${user.accessToken}`),
    post: (url: string) =>
      supertest(app).post(url).set('Authorization', `Bearer ${user.accessToken}`),
    patch: (url: string) =>
      supertest(app).patch(url).set('Authorization', `Bearer ${user.accessToken}`),
    delete: (url: string) =>
      supertest(app).delete(url).set('Authorization', `Bearer ${user.accessToken}`),
  };
}
