import { Hono } from 'hono';
import type { GlideMQEnv, QueueConfig } from '../../src/types';
import { QueueRegistryImpl } from '../../src/registry';
import { glideMQApi } from '../../src/api';

/**
 * Create a test Hono app with glideMQ middleware in testing mode.
 * No Valkey required.
 */
export function buildTestApp(queues: Record<string, QueueConfig> = { default: {} }) {
  const registry = new QueueRegistryImpl({ queues, testing: true });
  const app = new Hono<GlideMQEnv>();

  app.use(async (c, next) => {
    c.set('glideMQ', registry);
    await next();
  });

  app.route('/', glideMQApi());

  return { app, registry };
}
