import { Hono } from 'hono';
import type { Context } from 'hono';
import type { GlideMQEnv, GlideMQApiConfig, QueueRegistry } from './types';
import { serializeJob, serializeJobs } from './serializers';
import { buildSchemas, getZValidator, hasZod } from './schemas';
import { createEventsRoute } from './events';

function getRegistry(c: { var: { glideMQ: QueueRegistry } }): QueueRegistry {
  const registry = c.var.glideMQ;
  if (!registry) {
    throw new Error('GlideMQ middleware not applied. Use app.use(glideMQ(config)) first.');
  }
  return registry;
}

/**
 * Create the glide-mq API sub-router with all REST endpoints.
 *
 * @example
 * ```ts
 * const app = new Hono();
 * app.use(glideMQ({ ... }));
 * app.route('/api/queues', glideMQApi());
 * ```
 */
export function glideMQApi(opts?: GlideMQApiConfig) {
  const allowedQueues = opts?.queues;
  const schemas = hasZod() ? buildSchemas() : null;
  const zv = getZValidator();

  const api = new Hono<GlideMQEnv>();

  api.onError((_err, c) => {
    return c.json({ error: 'Internal server error' }, 500);
  });

  // Guard: ensure queue name is valid, exists, and is allowed
  const VALID_QUEUE_NAME = /^[a-zA-Z0-9_-]{1,128}$/;

  const guardQueue = async (c: Context<GlideMQEnv>, next: () => Promise<void>) => {
    const name = c.req.param('name');

    if (!VALID_QUEUE_NAME.test(name)) {
      return c.json({ error: 'Invalid queue name' }, 400);
    }

    const registry = getRegistry(c);

    if ((allowedQueues && !allowedQueues.includes(name)) || !registry.has(name)) {
      return c.json({ error: 'Queue not found or not accessible' }, 404);
    }
    await next();
  };

  api.use('/:name/*', guardQueue);
  api.use('/:name', guardQueue);

  // Zod validation hook: return 400 with flat error on failure
  const onValidationError = (
    result: { success: boolean; error?: { issues: Array<{ path: (string | number)[]; message: string }> } },
    c: Context,
  ) => {
    if (!result.success) {
      const issues = result.error!.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
      return c.json({ error: 'Validation failed', details: issues }, 400);
    }
  };

  // POST /:name/jobs - Add a job
  if (schemas && zv) {
    api.post('/:name/jobs', zv('json', schemas.addJobSchema, onValidationError), async (c) => {
      const name = c.req.param('name');
      const registry = getRegistry(c);
      const { queue } = registry.get(name);
      const body = c.req.valid('json' as never) as { name: string; data: unknown; opts: Record<string, unknown> };

      const job = await queue.add(body.name, body.data, body.opts as any);
      if (!job) {
        return c.json({ error: 'Job deduplicated' }, 409);
      }
      return c.json(serializeJob(job), 201);
    });
  } else {
    api.post('/:name/jobs', async (c) => {
      const name = c.req.param('name');
      const registry = getRegistry(c);
      const { queue } = registry.get(name);
      const body = await c.req.json<{ name: string; data?: unknown; opts?: Record<string, unknown> }>();

      if (!body.name || typeof body.name !== 'string') {
        return c.json({ error: 'name is required and must be a string' }, 400);
      }

      const job = await queue.add(body.name, body.data ?? {}, (body.opts ?? {}) as any);
      if (!job) {
        return c.json({ error: 'Job deduplicated' }, 409);
      }
      return c.json(serializeJob(job), 201);
    });
  }

  // GET /:name/jobs - List jobs
  if (schemas && zv) {
    api.get('/:name/jobs', zv('query', schemas.getJobsQuerySchema, onValidationError), async (c) => {
      const name = c.req.param('name');
      const registry = getRegistry(c);
      const { queue } = registry.get(name);

      const { type, start, end } = c.req.valid('query' as never) as { type: string; start: number; end: number };

      const jobs = await queue.getJobs(type as any, start, end);
      return c.json(serializeJobs(jobs));
    });
  } else {
    api.get('/:name/jobs', async (c) => {
      const name = c.req.param('name');
      const registry = getRegistry(c);
      const { queue } = registry.get(name);

      const type = (c.req.query('type') ?? 'waiting') as 'waiting' | 'active' | 'delayed' | 'completed' | 'failed';
      const start = parseInt(c.req.query('start') ?? '0', 10);
      const end = parseInt(c.req.query('end') ?? '-1', 10);

      if (isNaN(start) || isNaN(end)) {
        return c.json({ error: 'start and end must be numbers' }, 400);
      }

      const jobs = await queue.getJobs(type, start, end);
      return c.json(serializeJobs(jobs));
    });
  }

  // GET /:name/jobs/:id - Get a single job
  api.get('/:name/jobs/:id', async (c) => {
    const name = c.req.param('name');
    const jobId = c.req.param('id');
    const registry = getRegistry(c);
    const { queue } = registry.get(name);

    const job = await queue.getJob(jobId);
    if (!job) {
      return c.json({ error: 'Job not found' }, 404);
    }
    return c.json(serializeJob(job));
  });

  // GET /:name/counts - Get job counts
  api.get('/:name/counts', async (c) => {
    const name = c.req.param('name');
    const registry = getRegistry(c);
    const { queue } = registry.get(name);

    const counts = await queue.getJobCounts();
    return c.json(counts);
  });

  // POST /:name/pause - Pause queue
  api.post('/:name/pause', async (c) => {
    const name = c.req.param('name');
    const registry = getRegistry(c);
    const { queue } = registry.get(name);

    await queue.pause();
    return c.body(null, 204);
  });

  // POST /:name/resume - Resume queue
  api.post('/:name/resume', async (c) => {
    const name = c.req.param('name');
    const registry = getRegistry(c);
    const { queue } = registry.get(name);

    await queue.resume();
    return c.body(null, 204);
  });

  // POST /:name/drain - Drain queue
  api.post('/:name/drain', async (c) => {
    const name = c.req.param('name');
    const registry = getRegistry(c);
    const { queue } = registry.get(name);

    await queue.drain();
    return c.body(null, 204);
  });

  // POST /:name/retry - Retry failed jobs
  if (schemas && zv) {
    api.post('/:name/retry', zv('json', schemas.retryBodySchema, onValidationError), async (c) => {
      const name = c.req.param('name');
      const registry = getRegistry(c);
      const { queue } = registry.get(name);

      const { count } = c.req.valid('json' as never) as { count?: number };

      const retried = await queue.retryJobs(count != null ? { count } : undefined);
      return c.json({ retried });
    });
  } else {
    api.post('/:name/retry', async (c) => {
      const name = c.req.param('name');
      const registry = getRegistry(c);
      const { queue } = registry.get(name);

      let count: number | undefined;
      try {
        const body = await c.req.json<{ count?: number }>();
        count = body.count;
      } catch {
        // No body or invalid JSON - retry all
      }

      if (count !== undefined && (!Number.isInteger(count) || count < 1)) {
        return c.json({ error: 'count must be a positive integer' }, 400);
      }

      const retried = await queue.retryJobs(count != null ? { count } : undefined);
      return c.json({ retried });
    });
  }

  // DELETE /:name/clean - Clean old jobs
  if (schemas && zv) {
    api.delete('/:name/clean', zv('query', schemas.cleanQuerySchema, onValidationError), async (c) => {
      const name = c.req.param('name');
      const registry = getRegistry(c);
      const { queue } = registry.get(name);

      const { grace, limit, type } = c.req.valid('query' as never) as { grace: number; limit: number; type: string };

      const removed = await queue.clean(grace, limit, type as any);
      return c.json({ removed: removed.length });
    });
  } else {
    api.delete('/:name/clean', async (c) => {
      const name = c.req.param('name');
      const registry = getRegistry(c);
      const { queue } = registry.get(name);

      const grace = parseInt(c.req.query('grace') ?? '0', 10);
      const limit = parseInt(c.req.query('limit') ?? '100', 10);
      const type = (c.req.query('type') ?? 'completed') as 'completed' | 'failed';

      if (isNaN(grace) || isNaN(limit)) {
        return c.json({ error: 'grace and limit must be numbers' }, 400);
      }

      const removed = await queue.clean(grace, limit, type);
      return c.json({ removed: removed.length });
    });
  }

  // GET /:name/workers - List workers
  api.get('/:name/workers', async (c) => {
    const name = c.req.param('name');
    const registry = getRegistry(c);
    const { queue } = registry.get(name);

    const workers = await queue.getWorkers();
    return c.json(workers);
  });

  // GET /:name/events - SSE stream
  api.get('/:name/events', createEventsRoute());

  return api;
}

export type GlideMQApiType = ReturnType<typeof glideMQApi>;
