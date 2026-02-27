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

export function getZod() {
  return z;
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
        priority: z.number().optional(),
        attempts: z.number().optional(),
        timeout: z.number().optional(),
        removeOnComplete: z
          .union([z.boolean(), z.number(), z.object({ age: z.number(), count: z.number() })])
          .optional(),
        removeOnFail: z
          .union([z.boolean(), z.number(), z.object({ age: z.number(), count: z.number() })])
          .optional(),
      })
      .optional()
      .default({}),
  });

  const getJobsQuerySchema = z.object({
    type: z.enum(['waiting', 'active', 'delayed', 'completed', 'failed']).default('waiting'),
    start: z.coerce.number().default(0),
    end: z.coerce.number().default(-1),
  });

  const cleanQuerySchema = z.object({
    grace: z.coerce.number().default(0),
    limit: z.coerce.number().default(100),
    type: z.enum(['completed', 'failed']).default('completed'),
  });

  const retryBodySchema = z.object({
    count: z.coerce.number().optional(),
  });

  return {
    addJobSchema,
    getJobsQuerySchema,
    cleanQuerySchema,
    retryBodySchema,
  };
}

export type Schemas = NonNullable<ReturnType<typeof buildSchemas>>;
