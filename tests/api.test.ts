import { describe, it, expect, afterEach } from 'vitest';
import { buildTestApp } from './helpers/test-app';

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

    it('returns 400 if name is missing (no zod)', async () => {
      const { app } = setup();
      const res = await app.request('/emails/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: { to: 'user@test.com' } }),
      });

      // Without zod, manual validation catches it
      expect(res.status).toBe(400);
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
});
