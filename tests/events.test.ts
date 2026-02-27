import { describe, it, expect, afterEach } from 'vitest';
import { buildTestApp } from './helpers/test-app';

describe('SSE events (testing mode)', () => {
  let cleanup: (() => Promise<void>) | null = null;

  afterEach(async () => {
    if (cleanup) {
      await cleanup();
      cleanup = null;
    }
  });

  it('returns SSE content-type', async () => {
    const { app, registry } = buildTestApp({
      emails: {
        processor: async (job: any) => ({ sent: true }),
      },
    });
    cleanup = () => registry.closeAll();

    const res = await app.request('/emails/events');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
  });

  it('returns 404 for unconfigured queue', async () => {
    const { app, registry } = buildTestApp({ emails: {} });
    cleanup = () => registry.closeAll();

    const res = await app.request('/unknown/events');
    expect(res.status).toBe(404);
  });
});
