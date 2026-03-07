/**
 * Zod schemas for API route validation.
 * Gracefully no-ops when Zod is not installed - the API routes
 * will skip validation and parse request bodies manually.
 */

let z: typeof import('zod') | null = null;
let zValidator: typeof import('@hono/zod-validator').zValidator | null = null;

try {
  z = require('zod');
  zValidator = require('@hono/zod-validator').zValidator;
} catch {
  // Zod or @hono/zod-validator not installed - validation disabled
}

export function hasZod(): boolean {
  return z !== null && zValidator !== null;
}

export function getZValidator() {
  return zValidator;
}

/**
 * Build schemas if Zod is available. Returns null if not.
 */
export function buildSchemas() {
  if (!z) return null;

  const addJobSchema = z.object({
    name: z.string().min(1),
    data: z.unknown().optional().default({}),
    opts: z
      .object({
        delay: z.number().optional(),
        priority: z.number().int().min(0).max(2048).optional(),
        attempts: z.number().optional(),
        timeout: z.number().optional(),
        removeOnComplete: z
          .union([z.boolean(), z.number(), z.object({ age: z.number(), count: z.number() })])
          .optional(),
        removeOnFail: z.union([z.boolean(), z.number(), z.object({ age: z.number(), count: z.number() })]).optional(),
        jobId: z.string().optional(),
        lifo: z.boolean().optional(),
        deduplication: z
          .object({
            id: z.string(),
            ttl: z.number().optional(),
            mode: z.enum(['simple', 'throttle', 'debounce']).optional(),
          })
          .optional(),
        ordering: z
          .object({
            key: z.string(),
            concurrency: z.number().optional(),
          })
          .optional(),
        cost: z.number().optional(),
        backoff: z
          .object({
            type: z.string(),
            delay: z.number(),
            jitter: z.number().optional(),
          })
          .optional(),
        parent: z
          .object({
            queue: z.string(),
            id: z.string(),
          })
          .optional(),
        ttl: z.number().optional(),
      })
      .optional()
      .default({}),
  });

  const getJobsQuerySchema = z.object({
    type: z.enum(['waiting', 'active', 'delayed', 'completed', 'failed']).default('waiting'),
    start: z.coerce.number().default(0),
    end: z.coerce.number().default(-1),
    excludeData: z
      .enum(['true', 'false'])
      .transform((v) => v === 'true')
      .optional(),
  });

  const cleanQuerySchema = z.object({
    grace: z.coerce.number().int().min(0).default(0),
    limit: z.coerce.number().int().min(1).default(100),
    type: z.enum(['completed', 'failed']).default('completed'),
  });

  const retryBodySchema = z.object({
    count: z.coerce.number().int().min(1).optional(),
  });

  const metricsQuerySchema = z.object({
    type: z.enum(['completed', 'failed']),
    start: z.coerce.number().default(0),
    end: z.coerce.number().default(-1),
  });

  const changePriorityBodySchema = z.object({
    priority: z.number().int().min(0).max(2048),
  });

  const changeDelayBodySchema = z.object({
    delay: z.number().int().min(0),
  });

  const upsertSchedulerBodySchema = z.object({
    schedule: z.object({
      pattern: z.string().optional(),
      every: z.number().optional(),
      repeatAfterComplete: z.boolean().optional(),
      tz: z.string().optional(),
      startDate: z.union([z.string(), z.number()]).optional(),
      endDate: z.union([z.string(), z.number()]).optional(),
      limit: z.number().optional(),
    }),
    template: z
      .object({
        name: z.string().optional(),
        data: z.unknown().optional(),
        opts: z.record(z.unknown()).optional(),
      })
      .optional(),
  });

  const addAndWaitBodySchema = z.object({
    name: z.string().min(1),
    data: z.unknown().optional().default({}),
    opts: addJobSchema.shape.opts,
    waitTimeout: z.number().optional(),
  });

  return {
    addJobSchema,
    getJobsQuerySchema,
    cleanQuerySchema,
    retryBodySchema,
    metricsQuerySchema,
    changePriorityBodySchema,
    changeDelayBodySchema,
    upsertSchedulerBodySchema,
    addAndWaitBodySchema,
  };
}

export type Schemas = NonNullable<ReturnType<typeof buildSchemas>>;
