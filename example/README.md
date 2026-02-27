# @glidemq/hono Example

A realistic Hono app showing @glidemq/hono in action with 3 queues, REST API, custom routes, and SSE events.

## Prerequisites

- Node.js 20+
- Valkey or Redis running on localhost:6379

## Setup

```bash
cd example
npm install
npm start
```

## Endpoints

### Custom routes

```bash
# Send an email
curl -X POST http://localhost:3000/send-email \
  -H 'Content-Type: application/json' \
  -d '{"to": "user@example.com", "subject": "Hello", "body": "World"}'

# Generate a report
curl -X POST http://localhost:3000/generate-report \
  -H 'Content-Type: application/json' \
  -d '{"type": "monthly"}'

# Dashboard (all queue stats)
curl http://localhost:3000/dashboard
```

### Queue API (auto-generated)

```bash
# Add a job
curl -X POST http://localhost:3000/api/queues/emails/jobs \
  -H 'Content-Type: application/json' \
  -d '{"name": "welcome", "data": {"to": "new-user@example.com"}}'

# List jobs
curl http://localhost:3000/api/queues/emails/jobs?type=completed

# Get job counts
curl http://localhost:3000/api/queues/emails/counts

# Pause a queue
curl -X POST http://localhost:3000/api/queues/reports/pause

# Resume a queue
curl -X POST http://localhost:3000/api/queues/reports/resume
```

### SSE Events

```bash
# Stream events from a queue
curl -N http://localhost:3000/api/queues/emails/events
```

Or in a browser:

```js
const es = new EventSource('http://localhost:3000/api/queues/emails/events');
es.addEventListener('completed', (e) => console.log('Done:', JSON.parse(e.data)));
es.addEventListener('failed', (e) => console.log('Failed:', JSON.parse(e.data)));
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| PORT | 3000 | Server port |
| VALKEY_HOST | localhost | Valkey hostname |
| VALKEY_PORT | 6379 | Valkey port |
