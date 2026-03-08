# Changelog

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
