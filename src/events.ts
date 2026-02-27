import { streamSSE } from 'hono/streaming';
import type { Context } from 'hono';
import type { GlideMQEnv, QueueRegistry } from './types';

interface EventSubscription {
  queueEvents: any;
  refCount: number;
}

const subscriptions = new Map<string, EventSubscription>();

/**
 * Get or create a shared QueueEvents instance for a given queue name.
 * Uses ref counting so multiple SSE clients share a single listener.
 */
function acquireQueueEvents(name: string, connectionOpts: any, prefix?: string): any {
  const existing = subscriptions.get(name);
  if (existing) {
    existing.refCount++;
    return existing.queueEvents;
  }

  const { QueueEvents } = require('glide-mq') as {
    QueueEvents: new (name: string, opts: any) => any;
  };

  const queueEvents = new QueueEvents(name, {
    connection: connectionOpts,
    prefix,
  });

  subscriptions.set(name, { queueEvents, refCount: 1 });
  return queueEvents;
}

function releaseQueueEvents(name: string): void {
  const sub = subscriptions.get(name);
  if (!sub) return;
  sub.refCount--;
  if (sub.refCount <= 0) {
    sub.queueEvents.close().catch(() => {});
    subscriptions.delete(name);
  }
}

/**
 * Creates the SSE event route handler.
 * In testing mode, uses polling since TestQueue has no QueueEvents.
 */
export function createEventsRoute() {
  return (c: Context<GlideMQEnv>) => {
    const name = c.req.param('name');
    const registry = c.var.glideMQ;

    if (registry.testing) {
      return createTestingSSE(c, registry, name);
    }

    return createLiveSSE(c, registry, name);
  };
}

function createLiveSSE(c: Context<GlideMQEnv>, registry: QueueRegistry, name: string) {
  const connection = registry.getConnection();
  const prefix = registry.getPrefix();

  if (!connection) {
    return c.json({ error: 'Connection config required for SSE events' }, 500);
  }

  const queueEvents = acquireQueueEvents(name, connection, prefix);
  let eventId = 0;

  return streamSSE(c, async (stream) => {
    const eventTypes = ['completed', 'failed', 'progress', 'stalled', 'active', 'waiting'];
    const listeners: Array<{ event: string; handler: (...args: any[]) => void }> = [];
    let running = true;

    for (const eventType of eventTypes) {
      const handler = (args: any) => {
        if (!running) return;
        stream
          .writeSSE({
            event: eventType,
            data: JSON.stringify({ ...args, queue: name }),
            id: String(eventId++),
          })
          .catch(() => {});
      };
      queueEvents.on(eventType, handler);
      listeners.push({ event: eventType, handler });
    }

    stream.onAbort(() => {
      running = false;
    });

    try {
      while (running) {
        try {
          await stream.writeSSE({
            event: 'heartbeat',
            data: JSON.stringify({ time: Date.now() }),
            id: String(eventId++),
          });
        } catch {
          break;
        }
        await stream.sleep(15_000);
      }
    } finally {
      for (const { event, handler } of listeners) {
        queueEvents.removeListener(event, handler);
      }
      releaseQueueEvents(name);
    }
  });
}

function createTestingSSE(c: Context<GlideMQEnv>, registry: QueueRegistry, name: string) {
  let eventId = 0;
  const { queue } = registry.get(name);

  return streamSSE(c, async (stream) => {
    let lastCounts = { waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0 };
    let running = true;

    stream.onAbort(() => {
      running = false;
    });

    while (running) {
      try {
        const counts = await queue.getJobCounts();
        if (!running) break;
        // Emit change events by diffing counts
        for (const [state, count] of Object.entries(counts) as [string, number][]) {
          const prev = (lastCounts as any)[state] ?? 0;
          if (count !== prev) {
            await stream.writeSSE({
              event: 'counts',
              data: JSON.stringify({ queue: name, state, count, prev }),
              id: String(eventId++),
            });
          }
        }
        lastCounts = counts;
      } catch {
        // Queue may be closed
        break;
      }
      await stream.sleep(1_000);
    }
  });
}
