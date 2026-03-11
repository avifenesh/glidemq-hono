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
  const allowedProducers = opts?.producers;
  const schemas = hasZod() ? buildSchemas() : null;
  const zv = getZValidator();

  const api = new Hono<GlideMQEnv>();

  api.onError((err, c) => {
    console.error('[glidemq]', err);
    return c.json({ error: 'Internal server error' }, 500);
  });

  // Guard: ensure queue name is valid, exists, and is allowed
  const VALID_QUEUE_NAME = /^[a-zA-Z0-9_-]{1,128}$/;

  const guardQueue = async (c: Context<GlideMQEnv>, next: () => Promise<void>) => {
    const name = c.req.param('name')!;

    if (!VALID_QUEUE_NAME.test(name)) {
      return c.json({ error: 'Invalid queue name' }, 400);
    }

    const registry = getRegistry(c);

    if ((allowedQueues && !allowedQueues.includes(name)) || !registry.has(name)) {
      return c.json({ error: 'Queue not found or not accessible' }, 404);
    }
    await next();
  };

  // Guard for /:name/produce - checks producer config instead of queue config
  const guardProducer = async (c: Context<GlideMQEnv>, next: () => Promise<void>) => {
    const name = c.req.param('name')!;

    if (!VALID_QUEUE_NAME.test(name)) {
      return c.json({ error: 'Invalid queue name' }, 400);
    }

    const registry = getRegistry(c);

    if ((allowedProducers && !allowedProducers.includes(name)) || !registry.hasProducer(name)) {
      return c.json({ error: 'Producer not found or not accessible' }, 404);
    }
    await next();
  };

  // Mount produce endpoint BEFORE the queue guard so it uses its own guard
  api.post('/:name/produce', guardProducer, async (c) => {
    const name = c.req.param('name')!;
    const registry = getRegistry(c);
    const producer = registry.getProducer(name);
    const body = await c.req.json<{ name: string; data?: unknown; opts?: Record<string, unknown> }>();

    if (!body.name || typeof body.name !== 'string') {
      return c.json({ error: 'Validation failed', details: ['name: Required'] }, 400);
    }

    const ALLOWED_OPTS = ['delay', 'priority', 'attempts', 'timeout', 'removeOnComplete', 'removeOnFail'];
    const rawOpts = body.opts ?? {};
    const safeOpts: Record<string, unknown> = {};
    for (const key of ALLOWED_OPTS) {
      if (key in rawOpts) safeOpts[key] = rawOpts[key];
    }

    const jobId = await producer.add(body.name, body.data ?? {}, safeOpts as any);
    if (!jobId) {
      return c.json({ error: 'Job deduplicated' }, 409);
    }
    return c.json({ id: jobId }, 201);
  });

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
      const name = c.req.param('name')!;
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
      const name = c.req.param('name')!;
      const registry = getRegistry(c);
      const { queue } = registry.get(name);
      const body = await c.req.json<{ name: string; data?: unknown; opts?: Record<string, unknown> }>();

      if (!body.name || typeof body.name !== 'string') {
        return c.json({ error: 'Validation failed', details: ['name: Required'] }, 400);
      }

      const ALLOWED_OPTS = [
        'delay',
        'priority',
        'attempts',
        'timeout',
        'removeOnComplete',
        'removeOnFail',
        'jobId',
        'lifo',
        'deduplication',
        'ordering',
        'cost',
        'backoff',
        'parent',
        'ttl',
      ];
      const rawOpts = body.opts ?? {};
      const safeOpts: Record<string, unknown> = {};
      for (const key of ALLOWED_OPTS) {
        if (key in rawOpts) safeOpts[key] = rawOpts[key];
      }
      const job = await queue.add(body.name, body.data ?? {}, safeOpts as any);
      if (!job) {
        return c.json({ error: 'Job deduplicated' }, 409);
      }
      return c.json(serializeJob(job), 201);
    });
  }

  // GET /:name/jobs - List jobs
  if (schemas && zv) {
    api.get('/:name/jobs', zv('query', schemas.getJobsQuerySchema, onValidationError), async (c) => {
      const name = c.req.param('name')!;
      const registry = getRegistry(c);
      const { queue } = registry.get(name);

      const { type, start, end, excludeData } = c.req.valid('query' as never) as {
        type: string;
        start: number;
        end: number;
        excludeData?: boolean;
      };

      const jobs = await (queue as any).getJobs(type, start, end, excludeData ? { excludeData: true } : undefined);
      return c.json(serializeJobs(jobs));
    });
  } else {
    api.get('/:name/jobs', async (c) => {
      const name = c.req.param('name')!;
      const registry = getRegistry(c);
      const { queue } = registry.get(name);

      const VALID_JOB_TYPES = ['waiting', 'active', 'delayed', 'completed', 'failed'] as const;
      const typeParam = c.req.query('type') ?? 'waiting';

      if (!VALID_JOB_TYPES.includes(typeParam as any)) {
        return c.json(
          { error: 'Validation failed', details: [`type: must be one of ${VALID_JOB_TYPES.join(', ')}`] },
          400,
        );
      }

      const type = typeParam as (typeof VALID_JOB_TYPES)[number];
      const start = parseInt(c.req.query('start') ?? '0', 10);
      const end = parseInt(c.req.query('end') ?? '-1', 10);

      if (isNaN(start) || isNaN(end)) {
        return c.json({ error: 'Validation failed', details: ['start and end must be numbers'] }, 400);
      }

      const excludeData = c.req.query('excludeData') === 'true';
      const jobs = await (queue as any).getJobs(type, start, end, excludeData ? { excludeData: true } : undefined);
      return c.json(serializeJobs(jobs));
    });
  }

  // GET /:name/jobs/:id - Get a single job
  api.get('/:name/jobs/:id', async (c) => {
    const name = c.req.param('name')!;
    const jobId = c.req.param('id')!;
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
    const name = c.req.param('name')!;
    const registry = getRegistry(c);
    const { queue } = registry.get(name);

    const counts = await queue.getJobCounts();
    return c.json(counts);
  });

  // POST /:name/pause - Pause queue
  api.post('/:name/pause', async (c) => {
    const name = c.req.param('name')!;
    const registry = getRegistry(c);
    const { queue } = registry.get(name);

    await queue.pause();
    return c.body(null, 204);
  });

  // POST /:name/resume - Resume queue
  api.post('/:name/resume', async (c) => {
    const name = c.req.param('name')!;
    const registry = getRegistry(c);
    const { queue } = registry.get(name);

    await queue.resume();
    return c.body(null, 204);
  });

  // POST /:name/drain - Drain queue
  api.post('/:name/drain', async (c) => {
    const name = c.req.param('name')!;
    const registry = getRegistry(c);
    const { queue } = registry.get(name);

    await queue.drain();
    return c.body(null, 204);
  });

  // POST /:name/retry - Retry failed jobs
  if (schemas && zv) {
    api.post('/:name/retry', zv('json', schemas.retryBodySchema, onValidationError), async (c) => {
      const name = c.req.param('name')!;
      const registry = getRegistry(c);
      const { queue } = registry.get(name);

      const { count } = c.req.valid('json' as never) as { count?: number };

      const retried = await queue.retryJobs(count != null ? { count } : undefined);
      return c.json({ retried });
    });
  } else {
    api.post('/:name/retry', async (c) => {
      const name = c.req.param('name')!;
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
        return c.json({ error: 'Validation failed', details: ['count must be a positive integer'] }, 400);
      }

      const retried = await queue.retryJobs(count != null ? { count } : undefined);
      return c.json({ retried });
    });
  }

  // DELETE /:name/clean - Clean old jobs
  if (schemas && zv) {
    api.delete('/:name/clean', zv('query', schemas.cleanQuerySchema, onValidationError), async (c) => {
      const name = c.req.param('name')!;
      const registry = getRegistry(c);
      const { queue } = registry.get(name);

      const { grace, limit, type } = c.req.valid('query' as never) as { grace: number; limit: number; type: string };

      const removed = await queue.clean(grace, limit, type as any);
      return c.json({ removed: removed.length });
    });
  } else {
    api.delete('/:name/clean', async (c) => {
      const name = c.req.param('name')!;
      const registry = getRegistry(c);
      const { queue } = registry.get(name);

      const VALID_CLEAN_TYPES = ['completed', 'failed'] as const;
      const typeParam = c.req.query('type') ?? 'completed';

      if (!VALID_CLEAN_TYPES.includes(typeParam as any)) {
        return c.json(
          { error: 'Validation failed', details: [`type: must be one of ${VALID_CLEAN_TYPES.join(', ')}`] },
          400,
        );
      }

      const type = typeParam as (typeof VALID_CLEAN_TYPES)[number];
      const grace = parseInt(c.req.query('grace') ?? '0', 10);
      const limit = parseInt(c.req.query('limit') ?? '100', 10);

      if (isNaN(grace) || isNaN(limit) || grace < 0 || limit < 1) {
        return c.json({ error: 'Validation failed', details: ['grace must be >= 0 and limit must be >= 1'] }, 400);
      }

      const removed = await queue.clean(grace, limit, type);
      return c.json({ removed: removed.length });
    });
  }

  // GET /:name/workers - List workers
  api.get('/:name/workers', async (c) => {
    const name = c.req.param('name')!;
    const registry = getRegistry(c);
    const { queue } = registry.get(name);

    const workers = await queue.getWorkers();
    return c.json(workers);
  });

  // GET /:name/events - SSE stream
  api.get('/:name/events', createEventsRoute());

  // GET /:name/metrics - Get time-series metrics
  if (schemas && zv) {
    api.get('/:name/metrics', zv('query', schemas.metricsQuerySchema, onValidationError), async (c) => {
      const name = c.req.param('name')!;
      const registry = getRegistry(c);
      const { queue } = registry.get(name);

      const { type, start, end } = c.req.valid('query' as never) as { type: string; start: number; end: number };

      const metrics = await (queue as any).getMetrics(type, { start, end });
      return c.json(metrics);
    });
  } else {
    api.get('/:name/metrics', async (c) => {
      const name = c.req.param('name')!;
      const registry = getRegistry(c);
      const { queue } = registry.get(name);

      const VALID_METRIC_TYPES = ['completed', 'failed'] as const;
      const typeParam = c.req.query('type');

      if (!typeParam || !VALID_METRIC_TYPES.includes(typeParam as any)) {
        return c.json(
          { error: 'Validation failed', details: [`type: required, must be one of ${VALID_METRIC_TYPES.join(', ')}`] },
          400,
        );
      }

      const start = parseInt(c.req.query('start') ?? '0', 10);
      const end = parseInt(c.req.query('end') ?? '-1', 10);

      if (isNaN(start) || isNaN(end)) {
        return c.json({ error: 'Validation failed', details: ['start and end must be numbers'] }, 400);
      }

      const metrics = await (queue as any).getMetrics(typeParam, { start, end });
      return c.json(metrics);
    });
  }

  // POST /:name/jobs/:id/priority - Change job priority
  if (schemas && zv) {
    api.post('/:name/jobs/:id/priority', zv('json', schemas.changePriorityBodySchema, onValidationError), async (c) => {
      const name = c.req.param('name')!;
      const jobId = c.req.param('id')!;
      const registry = getRegistry(c);
      const { queue } = registry.get(name);

      const job = await queue.getJob(jobId);
      if (!job) {
        return c.json({ error: 'Job not found' }, 404);
      }

      const { priority } = c.req.valid('json' as never) as { priority: number };
      await (job as any).changePriority(priority);
      return c.body(null, 204);
    });
  } else {
    api.post('/:name/jobs/:id/priority', async (c) => {
      const name = c.req.param('name')!;
      const jobId = c.req.param('id')!;
      const registry = getRegistry(c);
      const { queue } = registry.get(name);

      const job = await queue.getJob(jobId);
      if (!job) {
        return c.json({ error: 'Job not found' }, 404);
      }

      const body = await c.req.json<{ priority?: number }>();
      if (body.priority == null || !Number.isInteger(body.priority) || body.priority < 0) {
        return c.json({ error: 'Validation failed', details: ['priority must be a non-negative integer'] }, 400);
      }

      await (job as any).changePriority(body.priority);
      return c.body(null, 204);
    });
  }

  // POST /:name/jobs/:id/delay - Change job delay
  if (schemas && zv) {
    api.post('/:name/jobs/:id/delay', zv('json', schemas.changeDelayBodySchema, onValidationError), async (c) => {
      const name = c.req.param('name')!;
      const jobId = c.req.param('id')!;
      const registry = getRegistry(c);
      const { queue } = registry.get(name);

      const job = await queue.getJob(jobId);
      if (!job) {
        return c.json({ error: 'Job not found' }, 404);
      }

      const { delay } = c.req.valid('json' as never) as { delay: number };
      await (job as any).changeDelay(delay);
      return c.body(null, 204);
    });
  } else {
    api.post('/:name/jobs/:id/delay', async (c) => {
      const name = c.req.param('name')!;
      const jobId = c.req.param('id')!;
      const registry = getRegistry(c);
      const { queue } = registry.get(name);

      const job = await queue.getJob(jobId);
      if (!job) {
        return c.json({ error: 'Job not found' }, 404);
      }

      const body = await c.req.json<{ delay?: number }>();
      if (body.delay == null || !Number.isInteger(body.delay) || body.delay < 0) {
        return c.json({ error: 'Validation failed', details: ['delay must be a non-negative integer'] }, 400);
      }

      await (job as any).changeDelay(body.delay);
      return c.body(null, 204);
    });
  }

  // POST /:name/jobs/:id/promote - Promote a delayed job
  api.post('/:name/jobs/:id/promote', async (c) => {
    const name = c.req.param('name')!;
    const jobId = c.req.param('id')!;
    const registry = getRegistry(c);
    const { queue } = registry.get(name);

    const job = await queue.getJob(jobId);
    if (!job) {
      return c.json({ error: 'Job not found' }, 404);
    }

    await (job as any).promote();
    return c.body(null, 204);
  });

  // GET /:name/schedulers - List all schedulers
  api.get('/:name/schedulers', async (c) => {
    const name = c.req.param('name')!;
    const registry = getRegistry(c);
    const { queue } = registry.get(name);

    const schedulers = await (queue as any).getRepeatableJobs();
    return c.json(schedulers);
  });

  // GET /:name/schedulers/:schedulerName - Get a single scheduler
  api.get('/:name/schedulers/:schedulerName', async (c) => {
    const name = c.req.param('name')!;
    const schedulerName = c.req.param('schedulerName');
    const registry = getRegistry(c);
    const { queue } = registry.get(name);

    const scheduler = await (queue as any).getJobScheduler(schedulerName);
    if (!scheduler) {
      return c.json({ error: 'Scheduler not found' }, 404);
    }
    return c.json(scheduler);
  });

  // PUT /:name/schedulers/:schedulerName - Upsert a scheduler
  if (schemas && zv) {
    api.put(
      '/:name/schedulers/:schedulerName',
      zv('json', schemas.upsertSchedulerBodySchema, onValidationError),
      async (c) => {
        const name = c.req.param('name')!;
        const schedulerName = c.req.param('schedulerName');
        const registry = getRegistry(c);
        const { queue } = registry.get(name);

        const { schedule, template } = c.req.valid('json' as never) as {
          schedule: Record<string, unknown>;
          template?: Record<string, unknown>;
        };

        const result = await (queue as any).upsertJobScheduler(schedulerName, schedule, template);
        return c.json(result, 200);
      },
    );
  } else {
    api.put('/:name/schedulers/:schedulerName', async (c) => {
      const name = c.req.param('name')!;
      const schedulerName = c.req.param('schedulerName');
      const registry = getRegistry(c);
      const { queue } = registry.get(name);

      const body = await c.req.json<{ schedule?: Record<string, unknown>; template?: Record<string, unknown> }>();

      if (!body.schedule || typeof body.schedule !== 'object') {
        return c.json({ error: 'Validation failed', details: ['schedule: Required'] }, 400);
      }

      const result = await (queue as any).upsertJobScheduler(schedulerName, body.schedule, body.template);
      return c.json(result, 200);
    });
  }

  // DELETE /:name/schedulers/:schedulerName - Remove a scheduler
  api.delete('/:name/schedulers/:schedulerName', async (c) => {
    const name = c.req.param('name')!;
    const schedulerName = c.req.param('schedulerName');
    const registry = getRegistry(c);
    const { queue } = registry.get(name);

    await (queue as any).removeJobScheduler(schedulerName);
    return c.body(null, 204);
  });

  // POST /:name/jobs/wait - Add a job and wait for result
  if (schemas && zv) {
    api.post('/:name/jobs/wait', zv('json', schemas.addAndWaitBodySchema, onValidationError), async (c) => {
      const name = c.req.param('name')!;
      const registry = getRegistry(c);
      const { queue } = registry.get(name);

      const body = c.req.valid('json' as never) as {
        name: string;
        data: unknown;
        opts: Record<string, unknown>;
        waitTimeout?: number;
      };

      const { waitTimeout, ...rest } = body;
      const result = await (queue as any).addAndWait(rest.name, rest.data, {
        ...rest.opts,
        ...(waitTimeout != null ? { timeout: waitTimeout } : {}),
      });
      return c.json(result);
    });
  } else {
    api.post('/:name/jobs/wait', async (c) => {
      const name = c.req.param('name')!;
      const registry = getRegistry(c);
      const { queue } = registry.get(name);

      const body = await c.req.json<{
        name: string;
        data?: unknown;
        opts?: Record<string, unknown>;
        waitTimeout?: number;
      }>();

      if (!body.name || typeof body.name !== 'string') {
        return c.json({ error: 'Validation failed', details: ['name: Required'] }, 400);
      }

      const opts = body.opts ?? {};
      const result = await (queue as any).addAndWait(body.name, body.data ?? {}, {
        ...opts,
        ...(body.waitTimeout != null ? { timeout: body.waitTimeout } : {}),
      });
      return c.json(result);
    });
  }

  return api;
}

export type GlideMQApiType = ReturnType<typeof glideMQApi>;
