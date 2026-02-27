# Changelog

## 0.1.0 (2026-02-27)

Initial release.

- `glideMQ(config)` middleware factory with lazy queue/worker initialization
- `glideMQApi()` sub-router with 11 REST endpoints for queue management
- SSE events endpoint with QueueEvents fan-out and ref counting
- `createTestApp()` helper using TestQueue/TestWorker (no Valkey needed)
- Type-safe RPC via exported `GlideMQApiType`
- Optional Zod validation (graceful no-op when not installed)
- Full TypeScript support with exported types
