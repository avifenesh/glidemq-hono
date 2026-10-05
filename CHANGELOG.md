# Changelog

## 0.5.1

- Validate the adapter against glide-mq 0.17.0 and refresh its development lockfile.
- Preserve the explicit authorization callback and the supported glide-mq peer range.

## 0.5.0

- Require an explicit `authorize` callback for the management API. Only `true` grants access; missing callbacks, other results, and callback errors return 403 before request parsing or backend access.
- Apply authorization to all mounted API paths and methods, including queue, producer, scheduler, flow, usage, broadcast, and SSE routes.
- Accept typed Hono middleware context in authorization callbacks. The in-memory `createTestApp` helper explicitly authorizes fixture requests.
- Migration: pass `glideMQApi({ authorize: (c) => canManageQueues(c) })` after your application's authentication middleware.

## 0.4.0

- Expand the HTTP surface to track glide-mq 0.15.0: queue-wide events SSE, per-job lifecycle SSE, `jobs/wait`, workers, metrics, scheduler CRUD, usage summary, broadcast publish/SSE, DLQ inspection/replay, suspended-job inspection, revoke, and queue global rate-limit management.
- Add flow HTTP routes for `POST /flows`, `GET /flows/:id`, `GET /flows/:id/tree`, and `DELETE /flows/:id`.
- Require glide-mq >=0.15.0 for the new flow and proxy-parity endpoints.

## 0.3.0

- Add AI-native endpoints: `GET /:name/flows/:id/usage`, `GET /:name/flows/:id/budget`, `GET /:name/jobs/:id/stream`
- Add AI event types to SSE: `usage`, `suspended`, `budget-exceeded`
- Serialize AI fields on jobs: `usage`, `signals`, `budgetKey`, `fallbackIndex`, `tpmTokens`
- Expand to 24 REST endpoints
- Require glide-mq >=0.14.0

## 0.2.1

- Require glide-mq >=0.9.0
- Add star callout and @glidemq/hapi to ecosystem cross-references
- Rewrite README for adoption and discoverability

## 0.2.0

- Expand to 21 REST endpoints (jobs, queue ops, producers, schedulers)
- Add serverless Producer endpoints (`POST /:name/produce`)
- Add scheduler CRUD endpoints (GET/PUT/DELETE `/:name/schedulers`)
- Add job mutation endpoints (priority, delay, promote)
- Add `addAndWait` endpoint
- Add queue metrics endpoint
- Re-export `Producer`, `ServerlessPool`, `serverlessPool` from glide-mq
- Support `excludeData` query parameter for lightweight job listings

## 0.1.0 (2026-02-27)

Initial release.

- `glideMQ(config)` middleware factory with lazy queue/worker initialization
- `glideMQApi()` sub-router with REST endpoints for queue management
- SSE events endpoint with QueueEvents fan-out and ref counting
- `createTestApp()` helper using TestQueue/TestWorker (no Valkey needed)
- Type-safe RPC via exported `GlideMQApiType`
- Optional Zod validation (graceful no-op when not installed)
- Full TypeScript support with exported types
