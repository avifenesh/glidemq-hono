# @glidemq/hono

[![npm](https://img.shields.io/npm/v/@glidemq/hono)](https://www.npmjs.com/package/@glidemq/hono)
[![license](https://img.shields.io/npm/l/@glidemq/hono)](https://github.com/avifenesh/glidemq-hono/blob/main/LICENSE)

Hono middleware that turns [glide-mq](https://github.com/avifenesh/glide-mq) queues into a REST API with real-time SSE and type-safe RPC. One middleware + one router gives you queue operations, schedulers, flow orchestration over HTTP, rolling usage summaries, and broadcast routes.

## Why

- **Type-safe RPC** - export `GlideMQApiType` and use Hono's `hc<>` for end-to-end typed HTTP calls with zero codegen
- **Multi-runtime** - runs on Node, Bun, Deno, and edge runtimes
- **Testable without Valkey** - `createTestApp` builds an in-memory app for `app.request()` assertions

## Install

```bash
npm install @glidemq/hono glide-mq hono
```

Optional - install `zod` and `@hono/zod-validator` for request validation.

Requires **glide-mq >= 0.14.0** and **Hono 4+**.

## Quick start

```ts
import { Hono } from "hono";
import { glideMQ, glideMQApi } from "@glidemq/hono";

const app = new Hono();

app.use(
  glideMQ({
    connection: { addresses: [{ host: "localhost", port: 6379 }] },
    queues: {
      emails: {
        processor: async (job) => {
          await sendEmail(job.data.to, job.data.subject);
          return { sent: true };
        },
        concurrency: 5,
      },
    },
  }),
);

app.route("/api/queues", glideMQApi());
export default app;
```

`glideMQ()` injects a registry into `c.var.glideMQ`. `glideMQApi()` returns a typed sub-router that exposes the full queue-management HTTP surface.

## Type-safe RPC client

```ts
import { hc } from "hono/client";
import type { GlideMQApiType } from "@glidemq/hono";

const client = hc<GlideMQApiType>("http://localhost:3000/api/queues");
const res = await client[":name"].jobs.$post({
  param: { name: "emails" },
  json: { name: "welcome", data: { to: "user@example.com" } },
});
const job = await res.json(); // typed as JobResponse
```

## AI-native features

glide-mq is an AI-native message queue. This middleware exposes AI orchestration primitives as REST endpoints:

- **`GET /:name/flows/:id/usage`** - aggregated token/cost usage across all jobs in a flow
- **`GET /:name/flows/:id/budget`** - budget state (limits, spent, exceeded) for a flow
- **`POST /flows`** - create a tree flow or DAG over HTTP with `{ flow, budget? }` or `{ dag }`
- **`GET /flows/:id`** - inspect a flow snapshot with nodes, roots, counts, usage, and budget
- **`GET /flows/:id/tree`** - inspect the nested tree view for a submitted tree flow or DAG
- **`DELETE /flows/:id`** - revoke or flag remaining jobs in a flow and delete the HTTP flow record
- **`GET /:name/jobs/:id/stream`** - SSE stream of real-time chunks from a streaming job
- **`GET /usage/summary`** - rolling per-queue or cross-queue usage summary from persisted minute buckets
- **`POST /broadcast/:name`** - publish a broadcast message with a `subject`, payload, and optional job options
- **`GET /broadcast/:name/events`** - SSE stream for broadcast delivery; requires `subscription` and optionally filters `subjects`

Jobs returned from all endpoints include AI fields when present: `usage`, `signals`, `budgetKey`, `fallbackIndex`, `tpmTokens`. SSE events include `usage`, `suspended`, and `budget-exceeded` event types.
HTTP-submitted budgets are currently supported for tree flows only, not DAG payloads.

See the [glide-mq docs](https://github.com/avifenesh/glide-mq) for the full AI primitives API.

## Configuration

`GlideMQConfig` accepts `connection`, `queues`, `producers`, `prefix` (default `"glide"`), and `testing` (boolean). Restrict exposed queue and broadcast names via `glideMQApi({ queues: ["emails"], producers: ["emails"] })`.

## Testing

```ts
import { createTestApp } from "@glidemq/hono/testing";

const { app, registry } = createTestApp({
  emails: { processor: async (job) => ({ sent: true }) },
});
const res = await app.request("/emails/jobs", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ name: "welcome", data: { to: "user@test.com" } }),
});
await registry.closeAll();
```

## Limitations

- Graceful shutdown is manual - call `registry.closeAll()` (Hono has no lifecycle hooks).
- SSE requires a long-lived connection; edge runtimes with short execution limits may not support it.
- `/flows*`, `GET /usage/summary`, and broadcast routes require a live `connection`; they are unavailable in testing mode.
- Producers not available in testing mode. Queue names must match `/^[a-zA-Z0-9_-]{1,128}$/`.

## Links

- [glide-mq](https://github.com/avifenesh/glide-mq) - core library
- [Full documentation](https://glidemq.dev/integrations/hono)
- [Issues](https://github.com/avifenesh/glidemq-hono/issues)
- [@glidemq/fastify](https://github.com/avifenesh/glidemq-fastify) | [@glidemq/hapi](https://github.com/avifenesh/glidemq-hapi) | [@glidemq/nestjs](https://github.com/avifenesh/glidemq-nestjs) | [@glidemq/dashboard](https://github.com/avifenesh/glidemq-dashboard)

## License

[Apache-2.0](./LICENSE)
