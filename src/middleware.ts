import { createMiddleware } from 'hono/factory';
import type { MiddlewareHandler } from 'hono';
import type { GlideMQConfig, GlideMQEnv, QueueRegistry } from './types';
import { QueueRegistryImpl } from './registry';

/**
 * Hono middleware factory for glide-mq.
 * Accepts either a config object (creates registry internally) or
 * a pre-constructed QueueRegistry (for graceful shutdown access).
 *
 * Injects the registry into `c.var.glideMQ`.
 *
 * @example
 * ```ts
 * // Option 1: pass config (simple, but no shutdown handle)
 * app.use(glideMQ({ connection, queues: { emails: { processor } } }));
 *
 * // Option 2: pass registry (recommended for graceful shutdown)
 * const registry = new QueueRegistryImpl({ connection, queues: { emails: { processor } } });
 * app.use(glideMQ(registry));
 * process.on('SIGTERM', () => registry.closeAll());
 * ```
 */
export function glideMQ(config: GlideMQConfig): MiddlewareHandler<GlideMQEnv>;
export function glideMQ(registry: QueueRegistry): MiddlewareHandler<GlideMQEnv>;
export function glideMQ(configOrRegistry: GlideMQConfig | QueueRegistry): MiddlewareHandler<GlideMQEnv> {
  // Discriminate: QueueRegistry has a `closeAll` method; GlideMQConfig does not.
  const registry: QueueRegistry =
    typeof (configOrRegistry as QueueRegistry).closeAll === 'function'
      ? (configOrRegistry as QueueRegistry)
      : new QueueRegistryImpl(configOrRegistry as GlideMQConfig);

  return createMiddleware<GlideMQEnv>(async (c, next) => {
    c.set('glideMQ', registry);
    await next();
  });
}
