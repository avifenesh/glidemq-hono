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

Requires **glide-mq >= 0.15.2** and **Hono >= 4.13.5**.

## Quick start

```ts
import { Hono } from "hono";
import { glideMQ, glideMQApi, type GlideMQEnv } from "@glidemq/hono";

// Authenticate requests with your application's middleware before mounting the API.
type AppEnv = GlideMQEnv & { Variables: { canManageQueues: boolean } };
const app = new Hono<AppEnv>();
app.use(authenticateSession); // Sets canManageQueues from a verified session.

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

app.route("/api/queues", glideMQApi<AppEnv>({
  authorize: (c) => c.get("canManageQueues") === true,
}));
export default app;
```

`glideMQ()` injects a registry into `c.var.glideMQ`. `glideMQApi()` returns a sub-router that exposes the full queue-management HTTP surface. Its `authorize` callback runs for every request before route validation, body parsing, queue access, or SSE subscriptions. Only a literal `true` grants access. A missing callback, any other result, or a thrown/rejected error returns `403 { "error": "Forbidden" }`.

The callback receives Hono's context and may be synchronous or asynchronous. Use authenticated session or middleware state to decide whether the caller may manage queues. Queue and producer name filters further restrict an authorized request. They do not grant access by themselves.

## Type-safe RPC client

```ts
import { hc } from "hono/client";
import type { GlideMQApiType } from "@glidemq/hono";

const client = hc<GlideMQApiType>("http://localhost:3000/api/queues", {
  headers: { Authorization: `Bearer ${accessToken}` },
});
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

`GlideMQConfig` accepts `connection`, `queues`, `producers`, `prefix` (default `"glide"`), and `testing` (boolean). `GlideMQApiConfig` requires `authorize`. Restrict exposed names with `glideMQApi({ authorize: canManageQueues, queues: ["emails"], producers: ["emails"] })`.

## Migrating to 0.5.0

Pass an `authorize` callback when mounting `glideMQApi`. Existing calls without it return 403 for every request, including unknown paths and HTTP methods. Install your authentication middleware before mounting the router and return `true` only for callers allowed to manage queues. Keep the callback scoped to the API's management permissions.

If mounting the exported low-level `createEventsRoute()` handler separately, apply your application's authorization middleware to that route as well.

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

`createTestApp` explicitly authorizes its in-memory fixture requests. It does not exercise your application's authentication. To test authorization, mount `glideMQApi({ authorize })` in your own Hono app with a testing-mode registry; testing mode alone never enables access.

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
