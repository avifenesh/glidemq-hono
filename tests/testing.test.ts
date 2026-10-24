import { describe, it, expect, afterEach } from 'vitest';
import { createTestApp } from '../src/testing';

describe('createTestApp', () => {
  let cleanup: (() => Promise<void>) | null = null;

  afterEach(async () => {
    if (cleanup) {
      await cleanup();
      cleanup = null;
    }
  });

  it('returns a working app and registry', async () => {
    const { app, registry } = createTestApp({
      emails: { processor: async (job: any) => ({ sent: true, to: job.data.to }) },
      reports: {},
    });
    cleanup = () => registry.closeAll();

    expect(registry.testing).toBe(true);
    expect(registry.names()).toEqual(['emails', 'reports']);

    const res = await app.request('/emails/jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'welcome', data: { to: 'user@test.com' } }),
    });

    expect(res.status).toBe(201);
    const job = await res.json();
    expect(job.name).toBe('welcome');
    expect(job.data).toEqual({ to: 'user@test.com' });
  });

  it('supports all API routes', async () => {
    const { app, registry } = createTestApp({ tasks: {} });
    cleanup = () => registry.closeAll();

    // Add a job
    const addRes = await app.request('/tasks/jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'do-thing', data: { x: 1 } }),
    });
    expect(addRes.status).toBe(201);

    // Get counts
    const countsRes = await app.request('/tasks/counts');
    expect(countsRes.status).toBe(200);
    const counts = await countsRes.json();
    expect(counts).toHaveProperty('waiting');

    // List jobs
    const listRes = await app.request('/tasks/jobs?type=waiting');
    expect(listRes.status).toBe(200);
    const jobs = await listRes.json();
    expect(Array.isArray(jobs)).toBe(true);
  });

  it('returns 404 for unconfigured queues', async () => {
    const { app, registry } = createTestApp({ emails: {} });
    cleanup = () => registry.closeAll();

    const res = await app.request('/unknown/counts');
    expect(res.status).toBe(404);
  });
  it('exposes GlideMQ 0.20 bounded scheduler inventories', async () => {
    const { app, registry } = createTestApp({ inventory: {} });
    cleanup = () => registry.closeAll();
    const { queue } = registry.get('inventory');
    await queue.upsertJobScheduler('one', { every: 60_000 });
    await queue.upsertJobScheduler('two', { every: 120_000 });
    expect(await queue.getRepeatableJobsBounded(2)).toHaveLength(2);
    await expect(queue.getRepeatableJobsBounded(1)).rejects.toThrow();
    await expect(queue.getRepeatableJobsBounded(0)).rejects.toThrow();
    expect(await queue.getRepeatableJobs()).toHaveLength(2);
    const res = await app.request('/inventory/schedulers');
    expect(res.status).toBe(200);
    expect(await res.json()).toHaveLength(2);
  });
});
