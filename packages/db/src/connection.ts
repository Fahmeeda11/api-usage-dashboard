/**
 * Mongo connection lifecycle.
 *
 * This package deliberately does NOT read process.env or import a logger. Both
 * the API and the worker have their own validated config and their own logger,
 * and a shared data layer that reached for globals would be impossible to point
 * at an in-memory database in tests. The caller passes the URI in; optional
 * hooks let it observe connection events with whatever logger it owns.
 *
 * `strictQuery` is on so a typo in a filter key throws instead of silently
 * matching every document - the difference between an error and
 * `deleteMany({ userid: x })` clearing the collection.
 */

import mongoose from 'mongoose';

mongoose.set('strictQuery', true);

export interface ConnectOptions {
  /** Called on connection lifecycle events, so the host app can log them. */
  onEvent?: (event: 'error' | 'disconnected' | 'reconnected', detail?: unknown) => void;
  /** Fail fast rather than queueing commands for 30s behind a dead server. */
  serverSelectionTimeoutMS?: number;
}

export async function connectDb(uri: string, options: ConnectOptions = {}): Promise<typeof mongoose> {
  const { onEvent, serverSelectionTimeoutMS = 5_000 } = options;

  if (onEvent) {
    mongoose.connection.on('error', (err) => onEvent('error', err));
    mongoose.connection.on('disconnected', () => onEvent('disconnected'));
    mongoose.connection.on('reconnected', () => onEvent('reconnected'));
  }

  await mongoose.connect(uri, { serverSelectionTimeoutMS });
  return mongoose;
}

export async function disconnectDb(): Promise<void> {
  await mongoose.connection.close();
}

export type ConnectionState =
  | 'disconnected'
  | 'connected'
  | 'connecting'
  | 'disconnecting'
  | 'uninitialized'
  | 'unknown';

/**
 * Mongoose readyState as a word. Note 99 ("uninitialized") is a real value the
 * driver can report, which is why this is an explicit map rather than an array
 * lookup - indexing a 4-element array with 99 would quietly yield undefined.
 */
export function connectionState(): ConnectionState {
  switch (mongoose.connection.readyState) {
    case 0:
      return 'disconnected';
    case 1:
      return 'connected';
    case 2:
      return 'connecting';
    case 3:
      return 'disconnecting';
    case 99:
      return 'uninitialized';
    default:
      return 'unknown';
  }
}

export function isConnected(): boolean {
  return mongoose.connection.readyState === 1;
}

/**
 * Build every declared index.
 *
 * Mongoose autoIndex is convenient in development but must be off in
 * production - implicitly building an index on a large collection at startup is
 * how you take an API down. Calling this explicitly at boot makes the cost
 * visible and timeable instead of hidden.
 */
export async function syncIndexes(
  onProgress?: (model: string, ms: number) => void,
): Promise<void> {
  for (const [name, model] of Object.entries(mongoose.models)) {
    const started = Date.now();
    await model.syncIndexes();
    onProgress?.(name, Date.now() - started);
  }
}

/** Every registered model, for test harnesses that need to clear or sync them. */
export function allModels() {
  return Object.values(mongoose.models);
}

export { mongoose };
