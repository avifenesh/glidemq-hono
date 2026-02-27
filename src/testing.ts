import { Hono } from 'hono';
import type { GlideMQEnv, QueueConfig, QueueRegistry } from './types';
import { QueueRegistryImpl } from './registry';
import { glideMQApi } from './api';

/**
 * Create a fully wired Hono app in testing mode.
 * Uses TestQueue/TestWorker from glide-mq/testing - no Valkey needed.
 *
 * @example
 * ```ts
 * import { createTestApp } from '@glidemq/hono/testing';
 *
 * const { app, registry } = createTestApp({
 *   emails: { processor: async (job) => ({ sent: true }) },
 *   reports: {},
 * });
 *
 * const res = await app.request('/emails/jobs', {
 *   method: 'POST',
 *   headers: { 'Content-Type': 'application/json' },
 *   body: JSON.stringify({ name: 'welcome', data: { to: 'user@example.com' } }),
 * });
 * ```
 */
export function createTestApp(queues: Record<string, QueueConfig>): {
  app: Hono<GlideMQEnv>;
  registry: QueueRegistry;
} {
  const registry = new QueueRegistryImpl({ queues, testing: true });
  const app = new Hono<GlideMQEnv>();

  app.use(async (c, next) => {
    c.set('glideMQ', registry);
    await next();
  });

  app.route('/', glideMQApi());

  return { app, registry };
}
