import { describe, it, expect, afterEach } from 'vitest';
import { Hono } from 'hono';
import type { GlideMQEnv } from '../src/types';
import { glideMQ } from '../src/middleware';

describe('glideMQ middleware', () => {
  it('injects registry into c.var.glideMQ', async () => {
    const app = new Hono<GlideMQEnv>();
    app.use(glideMQ({ queues: { test: {} }, testing: true }));

    app.get('/check', (c) => {
      const registry = c.var.glideMQ;
      return c.json({
        hasRegistry: !!registry,
        testing: registry.testing,
        names: registry.names(),
      });
    });

    const res = await app.request('/check');
    const body = await res.json();

    expect(body.hasRegistry).toBe(true);
    expect(body.testing).toBe(true);
    expect(body.names).toEqual(['test']);
  });

  it('shares same registry across requests', async () => {
    const app = new Hono<GlideMQEnv>();
    app.use(glideMQ({ queues: { test: {} }, testing: true }));

    let firstRef: any;
    let secondRef: any;

    app.get('/first', (c) => {
      firstRef = c.var.glideMQ;
      return c.json({ ok: true });
    });
    app.get('/second', (c) => {
      secondRef = c.var.glideMQ;
      return c.json({ ok: true });
    });

    await app.request('/first');
    await app.request('/second');

    expect(firstRef).toBe(secondRef);
  });
});
