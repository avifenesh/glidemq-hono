import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { serve } from '@hono/node-server';
import { glideMQ, glideMQApi } from '@glidemq/hono';
import type { GlideMQEnv } from '@glidemq/hono';
import type { Job } from 'glide-mq';

// --- Config ---

const PORT = parseInt(process.env.PORT ?? '3000', 10);

const connection = {
  addresses: [{ host: process.env.VALKEY_HOST ?? 'localhost', port: parseInt(process.env.VALKEY_PORT ?? '6379', 10) }],
};

// --- Processors ---

async function processEmail(job: Job) {
  console.log(`[email] Sending to ${job.data.to}: ${job.data.subject}`);
  // Simulate email sending
  await new Promise((r) => setTimeout(r, 500));
  return { sent: true, to: job.data.to, messageId: `msg-${Date.now()}` };
}

async function processReport(job: Job) {
  console.log(`[report] Generating ${job.data.type} report`);
  for (let i = 0; i <= 100; i += 25) {
    await job.updateProgress(i);
    await new Promise((r) => setTimeout(r, 300));
  }
  return { reportId: `rpt-${Date.now()}`, type: job.data.type, pages: 12 };
}

async function processNotification(job: Job) {
  console.log(`[notification] ${job.data.channel}: ${job.data.message}`);
  await new Promise((r) => setTimeout(r, 200));
  return { delivered: true, channel: job.data.channel };
}

// --- App ---

const app = new Hono<GlideMQEnv>();

// CORS for browser clients
app.use(cors());

// Mount glide-mq middleware
app.use(
  glideMQ({
    connection,
    queues: {
      emails: { processor: processEmail, concurrency: 5 },
      reports: { processor: processReport, concurrency: 1 },
      notifications: { processor: processNotification, concurrency: 10 },
    },
  }),
);

// Mount the REST API
app.route('/api/queues', glideMQApi());

// --- Custom routes ---

// Convenience: send an email
app.post('/send-email', async (c) => {
  const { to, subject, body: emailBody } = await c.req.json<{ to: string; subject: string; body: string }>();
  const { queue } = c.var.glideMQ.get('emails');
  const job = await queue.add('send', { to, subject, body: emailBody });
  return c.json({ jobId: job?.id, status: 'queued' }, 201);
});

// Convenience: generate a report
app.post('/generate-report', async (c) => {
  const { type } = await c.req.json<{ type: string }>();
  const { queue } = c.var.glideMQ.get('reports');
  const job = await queue.add('generate', { type });
  return c.json({ jobId: job?.id, status: 'queued' }, 201);
});

// Dashboard: all queue stats at a glance
app.get('/dashboard', async (c) => {
  const registry = c.var.glideMQ;
  const stats: Record<string, any> = {};

  for (const name of registry.names()) {
    const { queue } = registry.get(name);
    stats[name] = await queue.getJobCounts();
  }

  return c.json({ queues: stats, timestamp: Date.now() });
});

// Health check
app.get('/health', (c) => c.json({ status: 'ok' }));

// --- Start server ---

console.log(`Starting server on port ${PORT}...`);
console.log(`  Dashboard:  http://localhost:${PORT}/dashboard`);
console.log(`  Health:     http://localhost:${PORT}/health`);
console.log(`  API:        http://localhost:${PORT}/api/queues/:name/jobs`);
console.log(`  SSE:        http://localhost:${PORT}/api/queues/:name/events`);
console.log();

const server = serve({ fetch: app.fetch, port: PORT });

// Graceful shutdown
function shutdown() {
  console.log('\nShutting down...');
  // Get registry from the middleware closure - access it via a dummy request
  // For a real app, keep a reference to the registry
  server.close();
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
