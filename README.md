# @glidemq/hono

Hono middleware for [glide-mq](https://github.com/avifenesh/glide-mq) - queue management REST API and real-time SSE events.

## Install

```bash
npm install @glidemq/hono glide-mq hono
```

Optional Zod validation:

```bash
npm install zod @hono/zod-validator
```

## Quick Start

```ts
import { Hono } from 'hono';
import { glideMQ, glideMQApi } from '@glidemq/hono';

const app = new Hono();

app.use(glideMQ({
  connection: { addresses: [{ host: 'localhost', port: 6379 }] },
  queues: {
    emails: {
      processor: async (job) => {
        await sendEmail(job.data.to, job.data.subject);
        return { sent: true };
      },
      concurrency: 5,
    },
    reports: {},
  },
}));

app.route('/api/queues', glideMQApi());

export default app;
```

## API

### `glideMQ(config)`

Middleware factory. Creates a `QueueRegistry` and injects it into `c.var.glideMQ`.

```ts
interface GlideMQConfig {
  connection?: ConnectionOptions; // Required unless testing: true
  queues: Record<string, QueueConfig>;
  prefix?: string;                // Key prefix (default: 'glide')
  testing?: boolean;              // Use TestQueue/TestWorker (no Valkey)
}

interface QueueConfig {
  processor?: (job: Job) => Promise<any>; // Omit for producer-only
  concurrency?: number;                   // Default: 1
  workerOpts?: Record<string, unknown>;
}
```

### `glideMQApi(opts?)`

Pre-built REST API sub-router. Mount it on any path.

```ts
interface GlideMQApiConfig {
  queues?: string[];    // Restrict to specific queues
}
```

### REST Endpoints

| Method | Route | Description |
|--------|-------|-------------|
| POST | `/:name/jobs` | Add a job |
| GET | `/:name/jobs` | List jobs (query: `type`, `start`, `end`) |
| GET | `/:name/jobs/:id` | Get a single job |
| GET | `/:name/counts` | Get job counts by state |
| POST | `/:name/pause` | Pause queue |
| POST | `/:name/resume` | Resume queue |
| POST | `/:name/drain` | Drain waiting jobs |
| POST | `/:name/retry` | Retry failed jobs |
| DELETE | `/:name/clean` | Clean old jobs (query: `grace`, `limit`, `type`) |
| GET | `/:name/workers` | List active workers |
| GET | `/:name/events` | SSE event stream |

### Adding Jobs

```bash
curl -X POST http://localhost:3000/api/queues/emails/jobs \
  -H 'Content-Type: application/json' \
  -d '{"name": "welcome", "data": {"to": "user@example.com"}, "opts": {"priority": 10}}'
```

### SSE Events

```ts
const eventSource = new EventSource('/api/queues/emails/events');

eventSource.addEventListener('completed', (e) => {
  console.log('Job completed:', JSON.parse(e.data));
});

eventSource.addEventListener('failed', (e) => {
  console.log('Job failed:', JSON.parse(e.data));
});
```

### Type-Safe RPC Client

```ts
import { hc } from 'hono/client';
import type { GlideMQApiType } from '@glidemq/hono';

const client = hc<GlideMQApiType>('http://localhost:3000/api/queues');

const res = await client.emails.jobs.$post({
  json: { name: 'welcome', data: { to: 'user@example.com' } },
});
```

## Testing

No Valkey needed for unit tests:

```ts
import { createTestApp } from '@glidemq/hono/testing';

const { app, registry } = createTestApp({
  emails: {
    processor: async (job) => ({ sent: true }),
  },
});

const res = await app.request('/emails/jobs', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ name: 'test', data: {} }),
});

expect(res.status).toBe(201);

// Cleanup
await registry.closeAll();
```

## Direct Registry Access

Access the registry in your own routes:

```ts
app.post('/send-email', async (c) => {
  const registry = c.var.glideMQ;
  const { queue } = registry.get('emails');

  const job = await queue.add('send', {
    to: 'user@example.com',
    subject: 'Hello',
  });

  return c.json({ jobId: job?.id });
});
```

## Shutdown

For graceful shutdown, construct the registry yourself and pass it to `glideMQ()`:

```ts
import { glideMQ, glideMQApi, QueueRegistryImpl } from '@glidemq/hono';

const registry = new QueueRegistryImpl({
  connection: { addresses: [{ host: 'localhost', port: 6379 }] },
  queues: { emails: { processor: processEmail } },
});

app.use(glideMQ(registry));
app.route('/api/queues', glideMQApi());

process.on('SIGTERM', async () => {
  await registry.closeAll();
  process.exit(0);
});
```

## License

Apache-2.0
