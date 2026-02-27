import { describe, it, expect, afterEach } from 'vitest';
import { Hono } from 'hono';
import type { GlideMQEnv } from '../src/types';
import { QueueRegistryImpl } from '../src/registry';
import { glideMQApi } from '../src/api';
import { buildTestApp } from './helpers/test-app';

function buildRestrictedApp(allowedQueues: string[]) {
  const registry = new QueueRegistryImpl({
    queues: { emails: {}, reports: {}, secret: {} },
    testing: true,
  });
  const app = new Hono<GlideMQEnv>();
  app.use(async (c, next) => {
    c.set('glideMQ', registry);
    await next();
  });
  app.route('/', glideMQApi({ queues: allowedQueues }));
  return { app, registry };
}

describe('glideMQApi', () => {
  let cleanup: (() => Promise<void>) | null = null;

  afterEach(async () => {
    if (cleanup) {
      await cleanup();
      cleanup = null;
    }
  });

  function setup(queues?: Record<string, any>) {
    const { app, registry } = buildTestApp(
      queues ?? {
        emails: {
          processor: async (job: any) => ({ sent: true, to: job.data.to }),
        },
        reports: {},
      },
    );
    cleanup = () => registry.closeAll();
    return { app, registry };
  }

  describe('POST /:name/jobs', () => {
    it('adds a job and returns 201', async () => {
      const { app } = setup();
      const res = await app.request('/emails/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'welcome', data: { to: 'user@test.com' } }),
      });

      expect(res.status).toBe(201);
      const job = await res.json();
      expect(job.name).toBe('welcome');
      expect(job.data).toEqual({ to: 'user@test.com' });
      expect(job.id).toBeDefined();
    });

    it('returns 400 with error details if name is missing', async () => {
      const { app } = setup();
      const res = await app.request('/emails/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: { to: 'user@test.com' } }),
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe('Validation failed');
      expect(body.details).toBeDefined();
      expect(Array.isArray(body.details)).toBe(true);
    });

    it('returns 404 for unconfigured queue', async () => {
      const { app } = setup();
      const res = await app.request('/unknown/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'test', data: {} }),
      });

      expect(res.status).toBe(404);
    });
  });

  describe('GET /:name/jobs', () => {
    it('lists jobs', async () => {
      const { app } = setup();

      // Add a job first
      await app.request('/emails/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'test', data: {} }),
      });

      const res = await app.request('/emails/jobs?type=waiting');
      expect(res.status).toBe(200);
      const jobs = await res.json();
      expect(Array.isArray(jobs)).toBe(true);
    });
  });

  describe('GET /:name/jobs/:id', () => {
    it('returns a job by id', async () => {
      const { app } = setup();

      const addRes = await app.request('/emails/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'test', data: { x: 1 } }),
      });
      const added = await addRes.json();

      const res = await app.request(`/emails/jobs/${added.id}`);
      expect(res.status).toBe(200);
      const job = await res.json();
      expect(job.id).toBe(added.id);
      expect(job.data).toEqual({ x: 1 });
    });

    it('returns 404 for missing job', async () => {
      const { app } = setup();
      const res = await app.request('/emails/jobs/nonexistent');
      expect(res.status).toBe(404);
    });
  });

  describe('GET /:name/counts', () => {
    it('returns job counts', async () => {
      const { app } = setup();

      // Add some jobs
      await app.request('/emails/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'test1', data: {} }),
      });
      await app.request('/emails/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'test2', data: {} }),
      });

      const res = await app.request('/emails/counts');
      expect(res.status).toBe(200);
      const counts = await res.json();
      expect(counts).toHaveProperty('waiting');
      expect(counts).toHaveProperty('active');
      expect(counts).toHaveProperty('completed');
      expect(counts).toHaveProperty('failed');
    });
  });

  describe('POST /:name/pause', () => {
    it('pauses the queue', async () => {
      const { app } = setup();
      const res = await app.request('/emails/pause', { method: 'POST' });
      expect(res.status).toBe(204);
    });
  });

  describe('POST /:name/resume', () => {
    it('resumes the queue', async () => {
      const { app } = setup();
      // Pause first
      await app.request('/emails/pause', { method: 'POST' });
      const res = await app.request('/emails/resume', { method: 'POST' });
      expect(res.status).toBe(204);
    });
  });

  describe('POST /:name/drain', () => {
    it('drains the queue', async () => {
      const { app } = setup();
      const res = await app.request('/emails/drain', { method: 'POST' });
      expect(res.status).toBe(204);
    });
  });

  describe('POST /:name/retry', () => {
    it('retries failed jobs', async () => {
      const { app } = setup();
      const res = await app.request('/emails/retry', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toHaveProperty('retried');
    });
  });

  describe('DELETE /:name/clean', () => {
    it('cleans old jobs', async () => {
      const { app } = setup();
      const res = await app.request('/emails/clean?type=completed&grace=0&limit=100', {
        method: 'DELETE',
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toHaveProperty('removed');
    });
  });

  describe('GET /:name/workers', () => {
    it('returns worker list', async () => {
      const { app } = setup();
      const res = await app.request('/emails/workers');
      expect(res.status).toBe(200);
      const workers = await res.json();
      expect(Array.isArray(workers)).toBe(true);
    });
  });

  describe('GET /:name/jobs (Zod validation)', () => {
    it('returns 400 for invalid type param', async () => {
      const { app } = setup();
      const res = await app.request('/emails/jobs?type=bogus');
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe('Validation failed');
      expect(body.details).toBeDefined();
    });
  });

  describe('DELETE /:name/clean (Zod validation)', () => {
    it('returns 400 for invalid type param', async () => {
      const { app } = setup();
      const res = await app.request('/emails/clean?type=bogus', { method: 'DELETE' });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe('Validation failed');
      expect(body.details).toBeDefined();
    });
  });

  describe('GET /:name/jobs (query params)', () => {
    it('defaults to waiting when no type param', async () => {
      const { app } = setup();
      await app.request('/emails/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'test', data: {} }),
      });

      const res = await app.request('/emails/jobs');
      expect(res.status).toBe(200);
      const jobs = await res.json();
      expect(Array.isArray(jobs)).toBe(true);
    });

    it('returns empty array for type with no jobs', async () => {
      const { app } = setup();
      const res = await app.request('/emails/jobs?type=failed');
      expect(res.status).toBe(200);
      const jobs = await res.json();
      expect(jobs).toEqual([]);
    });
  });

  describe('POST /:name/retry (edge cases)', () => {
    it('handles retry with no body at all', async () => {
      const { app } = setup();
      const res = await app.request('/emails/retry', { method: 'POST' });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toHaveProperty('retried');
    });
  });

  describe('DELETE /:name/clean (variations)', () => {
    it('cleans with type=failed', async () => {
      const { app } = setup();
      const res = await app.request('/emails/clean?type=failed', { method: 'DELETE' });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(typeof body.removed).toBe('number');
    });

    it('defaults all params when none provided', async () => {
      const { app } = setup();
      const res = await app.request('/emails/clean', { method: 'DELETE' });
      expect(res.status).toBe(200);
    });
  });

  describe('POST /:name/jobs (defaults)', () => {
    it('defaults data to empty object when omitted', async () => {
      const { app } = setup();
      const res = await app.request('/emails/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'minimal' }),
      });
      expect(res.status).toBe(201);
      const job = await res.json();
      expect(job.name).toBe('minimal');
    });
  });
});

describe('glideMQApi with restricted queues', () => {
  let cleanup: (() => Promise<void>) | null = null;

  afterEach(async () => {
    if (cleanup) {
      await cleanup();
      cleanup = null;
    }
  });

  it('allows access to whitelisted queues', async () => {
    const { app, registry } = buildRestrictedApp(['emails']);
    cleanup = () => registry.closeAll();

    const res = await app.request('/emails/counts');
    expect(res.status).toBe(200);
  });

  it('returns 403 for non-whitelisted queue', async () => {
    const { app, registry } = buildRestrictedApp(['emails']);
    cleanup = () => registry.closeAll();

    const res = await app.request('/secret/counts');
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toContain('not accessible');
  });

  it('returns 403 for non-whitelisted queue job POST', async () => {
    const { app, registry } = buildRestrictedApp(['emails']);
    cleanup = () => registry.closeAll();

    const res = await app.request('/secret/jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'test', data: {} }),
    });
    expect(res.status).toBe(403);
  });

  it('allows multiple whitelisted queues', async () => {
    const { app, registry } = buildRestrictedApp(['emails', 'reports']);
    cleanup = () => registry.closeAll();

    const res1 = await app.request('/emails/counts');
    expect(res1.status).toBe(200);

    const res2 = await app.request('/reports/counts');
    expect(res2.status).toBe(200);

    const res3 = await app.request('/secret/counts');
    expect(res3.status).toBe(403);
  });
});

describe('glideMQApi without middleware', () => {
  it('throws when registry is not set', async () => {
    const app = new Hono();
    app.route('/', glideMQApi());

    const res = await app.request('/emails/jobs');
    expect(res.status).toBe(500);
  });
});

describe('glideMQApi error handler', () => {
  it('returns generic 500 without leaking internal details', async () => {
    const app = new Hono();
    app.route('/', glideMQApi());

    // Trigger error by calling without middleware (no registry set)
    const res = await app.request('/emails/counts');
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe('Internal server error');
    expect(body.error).not.toContain('middleware');
    expect(body.error).not.toContain('glideMQ');
  });
});
