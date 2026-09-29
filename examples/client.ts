/**
 * Minimal TypeScript ingest client.
 *
 * Drop this into any project that calls an LLM and wrap the call. The two things
 * that matter for a telemetry client, and that a naive version gets wrong:
 *
 *   1. BUFFER. One HTTP request per LLM call doubles your request count and adds
 *      the tracker's latency to every single call. Buffer and flush on a timer.
 *   2. NEVER THROW. Telemetry that can break the thing it measures is worse than
 *      no telemetry. Every failure path here swallows and moves on.
 */

export interface UsageEventInput {
  project: string;
  provider: string;
  model: string;
  promptTokens?: number;
  completionTokens?: number;
  costUsd?: number;
  latencyMs?: number;
  status?: 'ok' | 'error' | 'timeout' | 'rate_limited';
  metadata?: Record<string, string | number | boolean>;
  occurredAt?: string;
}

export interface UsageClientOptions {
  apiKey: string;
  baseUrl?: string;
  project: string;
  /** Flush interval. Lower is fresher; higher is fewer requests. */
  flushIntervalMs?: number;
  /** Flush immediately once this many events are buffered. */
  maxBatchSize?: number;
  onError?: (err: unknown) => void;
}

export class UsageClient {
  private queue: UsageEventInput[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly options: Required<Omit<UsageClientOptions, 'onError'>> &
    Pick<UsageClientOptions, 'onError'>;

  constructor(options: UsageClientOptions) {
    this.options = {
      baseUrl: 'http://localhost:4001',
      flushIntervalMs: 5_000,
      maxBatchSize: 100,
      ...options,
    };

    this.timer = setInterval(() => void this.flush(), this.options.flushIntervalMs);
    // Do not keep a short-lived script alive just because telemetry is pending.
    this.timer.unref?.();
  }

  /** Record an event. Returns immediately; the send happens on the next flush. */
  track(event: Omit<UsageEventInput, 'project'> & { project?: string }): void {
    this.queue.push({
      project: event.project ?? this.options.project,
      occurredAt: event.occurredAt ?? new Date().toISOString(),
      ...event,
    } as UsageEventInput);

    if (this.queue.length >= this.options.maxBatchSize) {
      void this.flush();
    }
  }

  /**
   * Time a call and record the result either way.
   *
   * The `finally`-style accounting is the point: a call that throws still cost
   * you latency and often tokens, and leaving failures out of the data makes the
   * error rate look perfect precisely when it is not.
   */
  async wrap<T>(
    meta: Omit<UsageEventInput, 'project' | 'latencyMs' | 'status'> & { project?: string },
    fn: () => Promise<T>,
  ): Promise<T> {
    const started = Date.now();
    try {
      const result = await fn();
      this.track({ ...meta, latencyMs: Date.now() - started, status: 'ok' });
      return result;
    } catch (err) {
      this.track({ ...meta, latencyMs: Date.now() - started, status: 'error' });
      throw err;
    }
  }

  async flush(): Promise<void> {
    if (this.queue.length === 0) return;

    // Take the batch out of the queue FIRST, so events recorded during the
    // request are not lost when the queue is cleared afterwards.
    const batch = this.queue.splice(0, this.options.maxBatchSize);

    try {
      const res = await fetch(`${this.options.baseUrl}/v1/events`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.options.apiKey}`,
        },
        body: JSON.stringify({ events: batch }),
      });

      if (res.status === 429) {
        // Rate limited: put the batch back and let the next flush retry, after
        // the window the server told us about.
        this.queue.unshift(...batch);
        return;
      }

      if (!res.ok) {
        this.options.onError?.(new Error(`Ingest failed: ${res.status}`));
      }
    } catch (err) {
      // Network failure. Drop the batch rather than growing an unbounded queue -
      // telemetry must never become the reason a process runs out of memory.
      this.options.onError?.(err);
    }
  }

  /** Flush and stop. Call before the process exits. */
  async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.flush();
  }
}

/* -------------------------------------------------------------------------- */
/* Usage                                                                      */
/* -------------------------------------------------------------------------- */

// const usage = new UsageClient({
//   apiKey: process.env.USAGE_API_KEY!,
//   baseUrl: 'http://localhost:4001',
//   project: 'production-rag-system',
// });
//
// const response = await usage.wrap(
//   { provider: 'anthropic', model: 'claude-opus-5' },
//   () => anthropic.messages.create({ ... }),
// );
//
// usage.track({
//   provider: 'anthropic',
//   model: 'claude-opus-5',
//   promptTokens: response.usage.input_tokens,
//   completionTokens: response.usage.output_tokens,
//   costUsd: estimateCost(response.usage),
// });
//
// await usage.close();
