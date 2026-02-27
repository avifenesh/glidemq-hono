import { createMiddleware } from 'hono/factory';
import type { GlideMQConfig, GlideMQEnv } from './types';
import { QueueRegistryImpl } from './registry';

/**
 * Hono middleware factory for glide-mq.
 * Creates a QueueRegistry and injects it into `c.var.glideMQ`.
 *
 * The registry is a singleton - created once on the first request and
 * shared across all subsequent requests.
 *
 * @example
 * ```ts
 * const app = new Hono();
 * app.use(glideMQ({
 *   connection: { addresses: [{ host: 'localhost', port: 6379 }] },
 *   queues: {
 *     emails: { processor: async (job) => sendEmail(job.data) },
 *     reports: {},
 *   },
 * }));
 * ```
 */
export function glideMQ(config: GlideMQConfig) {
  const registry = new QueueRegistryImpl(config);

  return createMiddleware<GlideMQEnv>(async (c, next) => {
    c.set('glideMQ', registry);
    await next();
  });
}
