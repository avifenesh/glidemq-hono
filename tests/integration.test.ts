import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Hono } from 'hono';
import { Queue } from 'glide-mq';
import type { GlideMQEnv } from '../src/types';
import { glideMQApi } from '../src/api';
import { QueueRegistryImpl } from '../src/registry';

/**
 * Integration tests - require a running Valkey instance on localhost:6379.
 * Skip if SKIP_INTEGRATION=1 is set.
 */
const VALKEY_HOST = process.env.VALKEY_HOST ?? 'localhost';
const VALKEY_PORT = parseInt(process.env.VALKEY_PORT ?? '6379', 10);

const connection = {
  addresses: [{ host: VALKEY_HOST, port: VALKEY_PORT }],
};

// Quick connectivity check
let canConnect = false;
try {
  const testQueue = new Queue('__hono_integration_check', { connection });
  await testQueue.close();
  canConnect = true;
} catch {
  canConnect = false;
}

describe.skipIf(!canConnect)('Integration (requires Valkey)', () => {
  let registry: QueueRegistryImpl;
  let app: Hono<GlideMQEnv>;
  const QUEUE_NAME = `hono_test_${Date.now()}`;

  beforeAll(() => {
    registry = new QueueRegistryImpl({
      connection,
      queues: {
        [QUEUE_NAME]: {
          processor: async (job) => ({ processed: true, data: job.data }),
          concurrency: 2,
        },
      },
    });

    app = new Hono<GlideMQEnv>();
    app.use(async (c, next) => {
      c.set('glideMQ', registry);
      await next();
    });
    app.route('/', glideMQApi());
  });

  afterAll(async () => {
    // Close workers first to stop XREADGROUP polling, then obliterate data
    try {
      const managed = registry.get(QUEUE_NAME);
      if (managed.worker) {
        await managed.worker.close();
      }
      await managed.queue.obliterate({ force: true });
    } catch {
      // Ignore cleanup errors
    }
    await registry.closeAll();
    // Allow any lingering async errors to flush
    await new Promise((r) => setTimeout(r, 200));
  });

  it('adds a job via API and retrieves it', async () => {
    const addRes = await app.request(`/${QUEUE_NAME}/jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'email', data: { to: 'integration@test.com' } }),
    });

    expect(addRes.status).toBe(201);
    const job = await addRes.json();
    expect(job.id).toBeDefined();
    expect(job.name).toBe('email');

    // Retrieve it
    const getRes = await app.request(`/${QUEUE_NAME}/jobs/${job.id}`);
    expect(getRes.status).toBe(200);
    const fetched = await getRes.json();
    expect(fetched.id).toBe(job.id);
  });

  it('gets job counts', async () => {
    const res = await app.request(`/${QUEUE_NAME}/counts`);
    expect(res.status).toBe(200);
    const counts = await res.json();
    expect(typeof counts.waiting).toBe('number');
    expect(typeof counts.active).toBe('number');
  });

  it('lists workers', async () => {
    // Ensure the worker is initialized by accessing the managed queue
    registry.get(QUEUE_NAME);

    const res = await app.request(`/${QUEUE_NAME}/workers`);
    expect(res.status).toBe(200);
    const workers = await res.json();
    expect(Array.isArray(workers)).toBe(true);
  });

  it('pauses and resumes', async () => {
    const pauseRes = await app.request(`/${QUEUE_NAME}/pause`, { method: 'POST' });
    expect(pauseRes.status).toBe(204);

    const resumeRes = await app.request(`/${QUEUE_NAME}/resume`, { method: 'POST' });
    expect(resumeRes.status).toBe(204);
  });

  it('processes jobs end-to-end', async () => {
    // Add a job
    const addRes = await app.request(`/${QUEUE_NAME}/jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'e2e',
        data: { payload: 'test' },
        opts: { removeOnComplete: false },
      }),
    });
    expect(addRes.status).toBe(201);
    const job = await addRes.json();

    // Wait for processing
    const { queue } = registry.get(QUEUE_NAME);
    const realJob = await queue.getJob(job.id);
    if (realJob) {
      try {
        await realJob.waitUntilFinished(100, 10_000);
      } catch {
        // May already be done
      }
    }

    // Check counts - completed should have increased
    const countsRes = await app.request(`/${QUEUE_NAME}/counts`);
    const counts = await countsRes.json();
    expect(counts.completed).toBeGreaterThanOrEqual(1);
  });

  it('drains the queue', async () => {
    // Add some jobs
    for (let i = 0; i < 3; i++) {
      await app.request(`/${QUEUE_NAME}/jobs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: `drain-${i}`, data: {} }),
      });
    }

    const res = await app.request(`/${QUEUE_NAME}/drain`, { method: 'POST' });
    expect(res.status).toBe(204);
  });

  it('SSE events endpoint responds', async () => {
    const res = await app.request(`/${QUEUE_NAME}/events`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
  });
});
