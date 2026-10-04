import { describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';
import { hc } from 'hono/client';
import { glideMQ } from '../src/middleware';
import { glideMQApi, type GlideMQApiType } from '../src/api';
import { QueueRegistryImpl } from '../src/registry';
import type { GlideMQApiConfig, GlideMQEnv, QueueRegistry } from '../src/types';

const routes = [
  ['GET', '/emails/jobs'],
  ['POST', '/emails/jobs'],
  ['POST', '/emails/pause'],
  ['DELETE', '/emails/clean'],
  ['POST', '/emails/produce'],
  ['GET', '/emails/schedulers'],
  ['PUT', '/emails/schedulers/nightly'],
  ['DELETE', '/emails/schedulers/nightly'],
  ['POST', '/flows'],
  ['GET', '/flows/flow-id'],
  ['GET', '/flows/flow-id/tree'],
  ['DELETE', '/flows/flow-id'],
  ['GET', '/emails/flows/flow-id/usage'],
  ['GET', '/emails/flows/flow-id/budget'],
  ['GET', '/usage/summary'],
  ['POST', '/broadcast/emails'],
  ['GET', '/broadcast/emails/events?subscription=reader'],
  ['GET', '/emails/events'],
  ['GET', '/emails/jobs/job-id/stream'],
  ['GET', '/unknown/jobs'],
  ['GET', '/'],
  ['GET', '/unknown/nested/route'],
] as const;

function buildDeniedApp(config?: GlideMQApiConfig) {
  const access = vi.fn(() => {
    throw new Error('A denied request accessed the registry');
  });
  const registry = new Proxy({} as QueueRegistry, { get: access });
  const app = new Hono<GlideMQEnv>();
  app.use(async (c, next) => {
    c.set('glideMQ', registry);
    await next();
  });
  app.route('/api', glideMQApi(config));
  return { app, access };
}

describe('management API authorization', () => {
  it.each([
    ['missing config', undefined],
    ['missing callback', {}],
    ['nonfunction callback', { authorize: true }],
    ['false', { authorize: () => false }],
    ['async false', { authorize: async () => false }],
    ['truthy string', { authorize: () => 'true' }],
    ['truthy number', { authorize: () => 1 }],
    ['truthy object', { authorize: () => ({}) }],
    ['undefined', { authorize: () => undefined }],
    [
      'throws',
      {
        authorize: () => {
          throw new Error('private authorization details');
        },
      },
    ],
    [
      'rejects',
      {
        authorize: async () => {
          throw new Error('private authorization details');
        },
      },
    ],
  ])('fails closed for %s across management routes', async (_name, config) => {
    const { app, access } = buildDeniedApp(config as GlideMQApiConfig | undefined);
    for (const [method, path] of routes) {
      const res = await app.request(`/api${path}`, {
        method,
        ...(method !== 'GET' ? { headers: { 'Content-Type': 'application/json' }, body: '{invalid-json' } : {}),
      });
      expect(res.status, `${method} ${path}`).toBe(403);
      expect(await res.json()).toEqual({ error: 'Forbidden' });
      expect(res.headers.get('content-type')).not.toContain('text/event-stream');
    }
    expect(access).not.toHaveBeenCalled();
  });

  it.each(['GET', 'HEAD', 'OPTIONS', 'POST', 'PUT', 'PATCH', 'DELETE', 'PROPFIND'])(
    'denies %s even for unknown routes',
    async (method) => {
      const authorize = vi.fn(() => false);
      const { app, access } = buildDeniedApp({ authorize });
      const res = await app.request('/api/unknown/nested/route', { method });
      expect(res.status).toBe(403);
      expect(authorize).toHaveBeenCalledOnce();
      expect(access).not.toHaveBeenCalled();
    },
  );

  it('authorizes before reading malformed bodies and does not affect routes outside the mount', async () => {
    const authorize = vi.fn((c) => {
      expect(c.req.raw.bodyUsed).toBe(false);
      return false;
    });
    const { app, access } = buildDeniedApp({ authorize });
    app.get('/health', (c) => c.text('ok'));
    const res = await app.request('/api/emails/jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{invalid-json',
    });
    expect(res.status).toBe(403);
    expect(authorize).toHaveBeenCalledOnce();
    expect(access).not.toHaveBeenCalled();
    expect((await app.request('/health')).status).toBe(200);
    expect(authorize).toHaveBeenCalledOnce();
  });

  it('does not authorize a testing-mode registry unless a callback grants access', async () => {
    const registry = new QueueRegistryImpl({ queues: { emails: {} }, testing: true });
    const app = new Hono<GlideMQEnv>();
    app.use(glideMQ(registry));
    app.route('/', glideMQApi());
    try {
      expect((await app.request('/emails/jobs')).status).toBe(403);
      expect((await registry.get('emails').queue.getJobs('waiting')).length).toBe(0);
    } finally {
      await registry.closeAll();
    }
  });

  it('allows scheduler and flow backend calls only after authorization', async () => {
    let allowed = false;
    const hgetall = vi.fn(async () => ({ kind: 'tree', createdAt: '1' }));
    const smembers = vi.fn(async () => []);
    const getRepeatableJobs = vi.fn(async () => [{ name: 'nightly' }]);
    const queue = { getRepeatableJobs, getClient: vi.fn(async () => ({ hgetall, smembers })) };
    const registry = {
      names: () => ['emails'],
      has: () => true,
      get: vi.fn(() => ({ queue, worker: null })),
      getPrefix: () => undefined,
      closeAll: async () => {},
    } as unknown as QueueRegistry;
    const app = new Hono<GlideMQEnv>();
    app.use(glideMQ(registry));
    app.route('/', glideMQApi({ authorize: () => allowed }));
    expect((await app.request('/emails/schedulers')).status).toBe(403);
    expect((await app.request('/flows/flow-id')).status).toBe(403);
    expect(registry.get).not.toHaveBeenCalled();
    allowed = true;
    const schedulers = await app.request('/emails/schedulers');
    expect(schedulers.status).toBe(200);
    expect(await schedulers.json()).toEqual([{ name: 'nightly' }]);
    const flow = await app.request('/flows/flow-id');
    expect(flow.status).toBe(200);
    expect((await flow.json()).flowId).toBe('flow-id');
    expect(getRepeatableJobs).toHaveBeenCalledOnce();
    expect(hgetall).toHaveBeenCalledOnce();
  });

  it('accepts typed middleware context and preserves RPC transport and queue operations', async () => {
    type AppEnv = GlideMQEnv & { Variables: { canManageQueues: boolean } };
    const registry = new QueueRegistryImpl({ queues: { emails: {} }, testing: true });
    const app = new Hono<AppEnv>();
    app.use(glideMQ(registry));
    app.use(async (c, next) => {
      c.set('canManageQueues', c.req.header('Authorization') === 'Bearer test-credential');
      await next();
    });
    const authorize = vi.fn(async (c: Parameters<GlideMQApiConfig<AppEnv>['authorize']>[0]) =>
      c.get('canManageQueues'),
    );
    app.route('/api', glideMQApi<AppEnv>({ authorize, queues: ['emails'] }));
    try {
      // The existing public API type has a BlankSchema. Test RPC transport without changing that contract.
      const client = hc<GlideMQApiType>('http://localhost/api', {
        fetch: (input: string | Request | URL, init?: RequestInit) => app.request(input, init),
        headers: { Authorization: 'Bearer test-credential' },
      }) as {
        ':name': {
          jobs: {
            $post: (args: { param: { name: string }; json: { name: string; data: unknown } }) => Promise<Response>;
          };
        };
      };
      const added = await client[':name'].jobs.$post({
        param: { name: 'emails' },
        json: { name: 'welcome', data: { to: 'user@test.com' } },
      });
      expect(added.status).toBe(201);
      const job = await added.json();
      const retrieved = await app.request(`/api/emails/jobs/${job.id}`, {
        headers: { Authorization: 'Bearer test-credential' },
      });
      expect(retrieved.status).toBe(200);
      expect((await retrieved.json()).data).toEqual({ to: 'user@test.com' });
      expect((await app.request('/api/emails/counts')).status).toBe(403);
      expect(
        (await app.request('/api/secret/jobs', { headers: { Authorization: 'Bearer test-credential' } })).status,
      ).toBe(404);
      expect(authorize).toHaveBeenCalledTimes(4);
    } finally {
      await registry.closeAll();
    }
  });
});
