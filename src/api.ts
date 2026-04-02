import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { Context } from 'hono';
import type { GlideMQEnv, GlideMQApiConfig, QueueRegistry } from './types';
import { serializeJob, serializeJobs } from './serializers';
import { buildSchemas, getZValidator, hasZod } from './schemas';
import { createEventsRoute } from './events';

const ALLOWED_JOB_OPTS = [
  'delay',
  'priority',
  'attempts',
  'timeout',
  'removeOnComplete',
  'removeOnFail',
  'jobId',
  'lifo',
  'deduplication',
  'ordering',
  'cost',
  'backoff',
  'parent',
  'ttl',
];

const VALID_QUEUE_NAME = /^[a-zA-Z0-9_-]{1,128}$/;
const SSE_HEARTBEAT_MS = 15_000;

type BroadcastClient = {
  matcher: ((subject: string) => boolean) | null;
  stream: {
    writeSSE: (chunk: { data: string; event?: string; id?: string }) => Promise<void>;
  };
};

type SharedBroadcastStream = {
  clients: Set<BroadcastClient>;
  closing: boolean;
  ready: Promise<void>;
  worker: { close: () => Promise<void> };
  close: () => Promise<void>;
};

type FlowKind = 'tree' | 'dag';

type FlowDefinition = {
  name: string;
  queueName: string;
  data: unknown;
  opts?: Record<string, unknown>;
  children?: FlowDefinition[];
};

type DagDefinition = {
  nodes: Array<{
    name: string;
    queueName: string;
    data: unknown;
    opts?: Record<string, unknown>;
    deps?: string[];
  }>;
};

type FlowJobRef = {
  jobId: string;
  queueName: string;
};

type FlowNodeSummary = ReturnType<typeof serializeJob> & {
  flowId: string;
  queueName: string;
  state: string;
  parentIds?: string[];
  parentQueues?: string[];
};

type FlowTreeNode = FlowNodeSummary & {
  children: FlowTreeNode[];
};

const broadcastStreams = new Map<string, SharedBroadcastStream>();

function flowMetaKey(flowId: string, prefix?: string): string {
  return `${prefix ?? 'glide'}:flow:${flowId}:meta`;
}

function flowJobsKey(flowId: string, prefix?: string): string {
  return `${prefix ?? 'glide'}:flow:${flowId}:jobs`;
}

function flowRootsKey(flowId: string, prefix?: string): string {
  return `${prefix ?? 'glide'}:flow:${flowId}:roots`;
}

function encodeFlowJobRef(ref: FlowJobRef): string {
  return `${ref.queueName}:${ref.jobId}`;
}

function decodeFlowJobRef(raw: string): FlowJobRef | null {
  const separator = raw.indexOf(':');
  if (separator <= 0 || separator === raw.length - 1) return null;
  return { queueName: raw.slice(0, separator), jobId: raw.slice(separator + 1) };
}

function hashEntriesToRecord(hashData: any): Record<string, string> | null {
  if (!Array.isArray(hashData) || hashData.length === 0) return null;
  const record: Record<string, string> = Object.create(null);
  for (const entry of hashData) {
    const key = entry?.field ?? entry?.key;
    if (key == null) continue;
    record[String(key)] = String(entry.value);
  }
  return Object.keys(record).length > 0 ? record : null;
}

function collectFlowQueueNames(flow: FlowDefinition, acc: Set<string> = new Set()): Set<string> {
  acc.add(flow.queueName);
  for (const child of flow.children ?? []) {
    collectFlowQueueNames(child, acc);
  }
  return acc;
}

function collectDagQueueNames(dag: DagDefinition): Set<string> {
  const names = new Set<string>();
  for (const node of dag.nodes) {
    names.add(node.queueName);
  }
  return names;
}

function buildFlowTreeNodes(flowId: string, roots: FlowJobRef[], nodes: FlowNodeSummary[]): FlowTreeNode[] {
  const nodeMap = new Map<string, FlowNodeSummary>();
  const childrenByParent = new Map<string, FlowNodeSummary[]>();

  for (const node of nodes) {
    nodeMap.set(encodeFlowJobRef({ jobId: node.id, queueName: node.queueName }), node);

    const parentRefs: FlowJobRef[] = [];
    if (node.parentIds && node.parentQueues && node.parentIds.length === node.parentQueues.length) {
      for (let i = 0; i < node.parentIds.length; i++) {
        parentRefs.push({ jobId: node.parentIds[i], queueName: node.parentQueues[i] });
      }
    } else if (node.parentId) {
      parentRefs.push({ jobId: node.parentId, queueName: node.queueName });
    }

    for (const parentRef of parentRefs) {
      const key = encodeFlowJobRef(parentRef);
      const siblings = childrenByParent.get(key);
      if (siblings) siblings.push(node);
      else childrenByParent.set(key, [node]);
    }
  }

  function visit(ref: FlowJobRef, path: Set<string>): FlowTreeNode {
    const key = encodeFlowJobRef(ref);
    const node = nodeMap.get(key);
    if (!node) {
      return {
        attemptsMade: 0,
        children: [],
        data: null,
        failedReason: undefined,
        finishedOn: undefined,
        flowId,
        id: ref.jobId,
        name: '',
        opts: {},
        parentId: undefined,
        parentIds: undefined,
        parentQueue: undefined,
        parentQueues: undefined,
        processedOn: undefined,
        progress: 0,
        queueName: ref.queueName,
        returnvalue: undefined,
        state: 'missing',
        timestamp: 0,
      };
    }

    const children = (childrenByParent.get(key) ?? [])
      .slice()
      .sort((a, b) => a.timestamp - b.timestamp || a.queueName.localeCompare(b.queueName) || a.id.localeCompare(b.id))
      .map((child) => {
        const childKey = encodeFlowJobRef({ jobId: child.id, queueName: child.queueName });
        if (path.has(childKey)) {
          return { ...child, children: [] };
        }
        const nextPath = new Set(path);
        nextPath.add(childKey);
        return visit({ jobId: child.id, queueName: child.queueName }, nextPath);
      });

    return { ...node, children };
  }

  return roots
    .slice()
    .sort((a, b) => a.queueName.localeCompare(b.queueName) || a.jobId.localeCompare(b.jobId))
    .map((root) => visit(root, new Set([encodeFlowJobRef(root)])));
}

function getRegistry(c: { var: { glideMQ: QueueRegistry } }): QueueRegistry {
  const registry = c.var.glideMQ;
  if (!registry) {
    throw new Error('GlideMQ middleware not applied. Use app.use(glideMQ(config)) first.');
  }
  return registry;
}

function parseIntegerParam(raw: string | undefined, name: string, opts?: { min?: number }): number | undefined {
  if (raw == null) return undefined;
  if (!/^-?\d+$/.test(raw)) {
    throw new Error(`${name} must be an integer`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) {
    throw new Error(`${name} must be an integer`);
  }
  if (opts?.min != null && value < opts.min) {
    throw new Error(`${name} must be >= ${opts.min}`);
  }
  return value;
}

function parseCsvParam(raw: string | undefined): string[] | undefined {
  if (!raw) return undefined;
  const values = raw
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  return values.length > 0 ? values : undefined;
}

function errorStatus(error: unknown): number {
  const message = error instanceof Error ? error.message : '';
  if (
    message.includes('must be') ||
    message.includes('window and windowMs') ||
    message.includes('Missing required') ||
    message.includes('exactly one of') ||
    message.includes('supported only for tree flows') ||
    message.includes('Invalid queue name')
  ) {
    return 400;
  }
  return 500;
}

function getLiveConnection(registry: QueueRegistry, feature: string) {
  const connection = registry.getConnection();
  if (!connection) {
    throw new Error(`Connection config required for ${feature}`);
  }
  return connection;
}

function ensureBroadcastAccess(name: string, allowedQueues?: string[]): string | null {
  if (!VALID_QUEUE_NAME.test(name)) {
    return 'Invalid queue name';
  }
  if (allowedQueues && !allowedQueues.includes(name)) {
    return 'Queue not found or not accessible';
  }
  return null;
}

function removeBroadcastClient(
  shared: SharedBroadcastStream,
  client: BroadcastClient,
  endResponse = false,
): void {
  if (!shared.clients.delete(client)) return;
  if (shared.clients.size === 0) {
    void shared.close();
  }
  if (endResponse) {
    void client.stream.writeSSE({ event: 'close', data: JSON.stringify({ ok: true }) }).catch(() => {});
  }
}

async function getSharedBroadcastStream(
  registry: QueueRegistry,
  name: string,
  subscription: string,
): Promise<SharedBroadcastStream> {
  const connection = getLiveConnection(registry, 'broadcast SSE');
  const prefix = registry.getPrefix();
  const cacheKey = `${prefix ?? ''}\u0000${name}\u0000${subscription}`;
  const cached = broadcastStreams.get(cacheKey);
  if (cached) {
    await cached.ready;
    return cached;
  }

  const { BroadcastWorker } = require('glide-mq') as typeof import('glide-mq');
  const clients = new Set<BroadcastClient>();

  const shared: SharedBroadcastStream = {
    clients,
    closing: false,
    ready: Promise.resolve(),
    worker: null as unknown as { close: () => Promise<void> },
    close: async () => {
      if (shared.closing) return;
      shared.closing = true;
      broadcastStreams.delete(cacheKey);
      clients.clear();
      await shared.worker.close();
    },
  };

  const worker = new BroadcastWorker(
    name,
    async (job: any) => {
      const payload = {
        data: job.data,
        id: job.id,
        subject: job.name,
        timestamp: job.timestamp,
      };
      for (const client of Array.from(shared.clients)) {
        if (client.matcher && !client.matcher(job.name)) continue;
        client.stream
          .writeSSE({
            event: 'message',
            data: JSON.stringify(payload),
            id: job.id,
          })
          .catch(() => {
            removeBroadcastClient(shared, client);
          });
      }
    },
    {
      blockTimeout: 5_000,
      connection,
      prefix,
      subscription,
    },
  );

  shared.worker = worker;
  shared.ready = worker.waitUntilReady();
  broadcastStreams.set(cacheKey, shared);

  try {
    await shared.ready;
    return shared;
  } catch (error) {
    broadcastStreams.delete(cacheKey);
    await worker.close().catch(() => undefined);
    throw error;
  }
}

/**
 * Create the glide-mq API sub-router with all REST endpoints.
 *
 * @example
 * ```ts
 * const app = new Hono();
 * app.use(glideMQ({ ... }));
 * app.route('/api/queues', glideMQApi());
 * ```
 */
export function glideMQApi(opts?: GlideMQApiConfig) {
  const allowedQueues = opts?.queues;
  const allowedProducers = opts?.producers;
  const schemas = hasZod() ? buildSchemas() : null;
  const zv = getZValidator();

  const api = new Hono<GlideMQEnv>();

  api.onError((err, c) => {
    return c.json({ error: 'Internal server error' }, 500);
  });

  // Guard: ensure queue name is valid, exists, and is allowed
  const guardQueue = async (c: Context<GlideMQEnv>, next: () => Promise<void>) => {
    const name = c.req.param('name')!;

    if (!VALID_QUEUE_NAME.test(name)) {
      return c.json({ error: 'Invalid queue name' }, 400);
    }

    const registry = getRegistry(c);

    if ((allowedQueues && !allowedQueues.includes(name)) || !registry.has(name)) {
      return c.json({ error: 'Queue not found or not accessible' }, 404);
    }
    await next();
  };

  // Guard for /:name/produce - checks producer config instead of queue config
  const guardProducer = async (c: Context<GlideMQEnv>, next: () => Promise<void>) => {
    const name = c.req.param('name')!;

    if (!VALID_QUEUE_NAME.test(name)) {
      return c.json({ error: 'Invalid queue name' }, 400);
    }

    const registry = getRegistry(c);

    if ((allowedProducers && !allowedProducers.includes(name)) || !registry.hasProducer(name)) {
      return c.json({ error: 'Producer not found or not accessible' }, 404);
    }
    await next();
  };

  function getFlowClientQueueNames(registry: QueueRegistry): string[] {
    const names = allowedQueues ?? registry.names();
    return names.filter((name) => registry.has(name));
  }

  async function getFlowClient(registry: QueueRegistry): Promise<any> {
    const queueNames = getFlowClientQueueNames(registry);
    if (queueNames.length === 0) {
      throw new Error('Flow HTTP endpoints require at least one configured queue');
    }
    const { queue } = registry.get(queueNames[0]);
    const client = await (queue as any).getClient?.();
    if (!client) {
      throw new Error('Connection config required for flow HTTP endpoints');
    }
    return client;
  }

  function assertAllowedFlowQueues(registry: QueueRegistry, queueNames: Iterable<string>): void {
    for (const queueName of queueNames) {
      if (!VALID_QUEUE_NAME.test(queueName)) {
        throw new Error('Invalid queue name');
      }
      if ((allowedQueues && !allowedQueues.includes(queueName)) || !registry.has(queueName)) {
        throw new Error('Queue not found or not accessible');
      }
    }
  }

  async function registerFlowRecord(
    registry: QueueRegistry,
    flowId: string,
    kind: FlowKind,
    roots: FlowJobRef[],
    jobs: FlowJobRef[],
  ): Promise<void> {
    const client = await getFlowClient(registry);
    const prefix = registry.getPrefix();
    await client.hset(flowMetaKey(flowId, prefix), { createdAt: Date.now().toString(), kind });
    await client.del([flowJobsKey(flowId, prefix), flowRootsKey(flowId, prefix)]);

    if (jobs.length > 0) {
      await client.sadd(
        flowJobsKey(flowId, prefix),
        jobs
          .slice()
          .sort((a, b) => a.queueName.localeCompare(b.queueName) || a.jobId.localeCompare(b.jobId))
          .map(encodeFlowJobRef),
      );
      for (const ref of jobs) {
        const { queue } = registry.get(ref.queueName);
        await client.hset((queue as any).keys.job(ref.jobId), { flowId });
      }
    }

    if (roots.length > 0) {
      await client.sadd(
        flowRootsKey(flowId, prefix),
        roots
          .slice()
          .sort((a, b) => a.queueName.localeCompare(b.queueName) || a.jobId.localeCompare(b.jobId))
          .map(encodeFlowJobRef),
      );
    }
  }

  async function loadFlowRecord(
    registry: QueueRegistry,
    flowId: string,
  ): Promise<{ createdAt: number; kind: FlowKind; jobs: FlowJobRef[]; roots: FlowJobRef[] } | null> {
    const client = await getFlowClient(registry);
    const prefix = registry.getPrefix();
    const meta = hashEntriesToRecord(await client.hgetall(flowMetaKey(flowId, prefix)));
    if (!meta?.kind) return null;

    const jobs = Array.from((await client.smembers(flowJobsKey(flowId, prefix))) ?? [])
      .map((entry) => decodeFlowJobRef(String(entry)))
      .filter((entry): entry is FlowJobRef => entry !== null);
    const roots = Array.from((await client.smembers(flowRootsKey(flowId, prefix))) ?? [])
      .map((entry) => decodeFlowJobRef(String(entry)))
      .filter((entry): entry is FlowJobRef => entry !== null);

    return {
      createdAt: Number(meta.createdAt || '0'),
      kind: meta.kind === 'dag' ? 'dag' : 'tree',
      jobs,
      roots,
    };
  }

  async function deleteFlowRecord(registry: QueueRegistry, flowId: string): Promise<void> {
    const client = await getFlowClient(registry);
    const prefix = registry.getPrefix();
    await client.del([flowMetaKey(flowId, prefix), flowJobsKey(flowId, prefix), flowRootsKey(flowId, prefix)]);
  }

  async function buildFlowSnapshot(registry: QueueRegistry, flowId: string) {
    const record = await loadFlowRecord(registry, flowId);
    if (!record) return null;
    assertAllowedFlowQueues(registry, record.jobs.map((job) => job.queueName));

    const nodes: FlowNodeSummary[] = [];
    const counts: Record<string, number> = Object.create(null);

    for (const ref of record.jobs) {
      const { queue } = registry.get(ref.queueName);
      const job = await queue.getJob(ref.jobId);
      if (!job) continue;
      const state = await (job as any).getState();
      counts[state] = (counts[state] || 0) + 1;
      nodes.push({
        ...serializeJob(job),
        flowId,
        parentIds: (job as any).parentIds,
        parentQueues: (job as any).parentQueues,
        queueName: ref.queueName,
        state,
      });
    }

    let usage: unknown = null;
    let budget: unknown = null;
    if (record.roots.length === 1) {
      const root = record.roots[0];
      const { queue } = registry.get(root.queueName);
      try {
        usage = await (queue as any).getFlowUsage(root.jobId);
      } catch {
        usage = null;
      }
      try {
        budget = await (queue as any).getFlowBudget(root.jobId);
      } catch {
        budget = null;
      }
    }

    return {
      budget,
      counts,
      createdAt: record.createdAt,
      flowId,
      kind: record.kind,
      nodes: nodes.sort((a, b) => a.timestamp - b.timestamp || a.queueName.localeCompare(b.queueName) || a.id.localeCompare(b.id)),
      roots: record.roots.slice().sort((a, b) => a.queueName.localeCompare(b.queueName) || a.jobId.localeCompare(b.jobId)),
      tree: buildFlowTreeNodes(flowId, record.roots, nodes),
      usage,
    };
  }

  // Mount produce endpoint BEFORE the queue guard so it uses its own guard
  api.post('/:name/produce', guardProducer, async (c) => {
    const name = c.req.param('name')!;
    const registry = getRegistry(c);
    const producer = registry.getProducer(name);
    const body = await c.req.json<{ name: string; data?: unknown; opts?: Record<string, unknown> }>();

    if (!body.name || typeof body.name !== 'string') {
      return c.json({ error: 'Validation failed', details: ['name: Required'] }, 400);
    }

    const rawOpts = body.opts ?? {};
    const safeOpts: Record<string, unknown> = {};
    for (const key of ALLOWED_JOB_OPTS) {
      if (key in rawOpts) safeOpts[key] = rawOpts[key];
    }

    const jobId = await producer.add(body.name, body.data ?? {}, safeOpts as any);
    if (!jobId) {
      return c.json({ error: 'Job deduplicated' }, 409);
    }
    return c.json({ id: jobId }, 201);
  });

  // Zod validation hook: return 400 with flat error on failure
  const onValidationError = (
    result: { success: boolean; error?: { issues: Array<{ path: (string | number)[]; message: string }> } },
    c: Context,
  ) => {
    if (!result.success) {
      const issues = result.error!.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
      return c.json({ error: 'Validation failed', details: issues }, 400);
    }
  };

  api.get('/usage/summary', async (c) => {
    try {
      const registry = getRegistry(c);
      const requestedQueues = parseCsvParam(c.req.query('queues'));
      if (requestedQueues) {
        for (const queueName of requestedQueues) {
          if (!VALID_QUEUE_NAME.test(queueName)) {
            return c.json({ error: 'Invalid queue name' }, 400);
          }
          if (allowedQueues && !allowedQueues.includes(queueName)) {
            return c.json({ error: 'Queue not found or not accessible' }, 404);
          }
        }
      }

      const connection = getLiveConnection(registry, 'usage summary');
      const { Queue } = require('glide-mq') as typeof import('glide-mq');
      const startTime = parseIntegerParam(c.req.query('start'), 'start', { min: 0 });
      const endTime = parseIntegerParam(c.req.query('end'), 'end', { min: 0 });
      const window = c.req.query('window');
      const windowMs = c.req.query('windowMs');

      if (window && windowMs && window !== windowMs) {
        return c.json({ error: 'window and windowMs must match when both are provided' }, 400);
      }

      const summary = await (Queue as any).getUsageSummary({
        connection,
        endTime,
        prefix: registry.getPrefix(),
        queues: requestedQueues ?? allowedQueues,
        startTime,
        windowMs: parseIntegerParam(windowMs ?? window, windowMs ? 'windowMs' : 'window', { min: 1 }),
      });

      return c.json(summary);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Internal server error';
      return c.json({ error: message }, errorStatus(error) as any);
    }
  });

  api.post('/flows', async (c) => {
    try {
      const registry = getRegistry(c);
      const body = await c.req.json<{ budget?: Record<string, unknown>; dag?: DagDefinition; flow?: FlowDefinition }>();

      if (!body || (!!body.flow && !!body.dag) || (!body.flow && !body.dag)) {
        return c.json({ error: 'Body must include exactly one of: flow, dag' }, 400);
      }

      const connection = getLiveConnection(registry, 'flow HTTP endpoints');

      const { FlowProducer } = require('glide-mq') as typeof import('glide-mq');
      const producer = new FlowProducer({
        connection,
        prefix: registry.getPrefix(),
      });

      try {
        if (body.flow) {
          const queueNames = collectFlowQueueNames(body.flow);
          assertAllowedFlowQueues(registry, queueNames);
          const node = await producer.add(body.flow as any, body.budget ? { budget: body.budget as any } : undefined);
          const refs: FlowJobRef[] = [];

          const collectRefs = (flowDef: FlowDefinition, jobNode: any) => {
            refs.push({ jobId: jobNode.job.id, queueName: flowDef.queueName });
            if (!flowDef.children || !jobNode.children) return;
            for (let i = 0; i < flowDef.children.length && i < jobNode.children.length; i++) {
              collectRefs(flowDef.children[i], jobNode.children[i]);
            }
          };

          collectRefs(body.flow, node);
          const root = { jobId: node.job.id, queueName: body.flow.queueName };
          await registerFlowRecord(registry, node.job.id, 'tree', [root], refs);
          return c.json({ flowId: node.job.id, kind: 'tree', nodeCount: refs.length, root, roots: [root] }, 201);
        }

        if (body.budget) {
          return c.json({ error: 'budget is currently supported only for tree flows' }, 400);
        }

        const dag = body.dag!;
        const queueNames = collectDagQueueNames(dag);
        assertAllowedFlowQueues(registry, queueNames);
        const jobs = await producer.addDAG(dag as any);
        const flowId = `dag-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
        const refs = dag.nodes.map((dagNode) => {
          const job = jobs.get(dagNode.name);
          if (!job) throw new Error(`Missing DAG job for node ${dagNode.name}`);
          return { jobId: job.id, queueName: dagNode.queueName };
        });
        const roots = dag.nodes
          .filter((dagNode) => !dagNode.deps || dagNode.deps.length === 0)
          .map((dagNode) => ({ jobId: jobs.get(dagNode.name)!.id, queueName: dagNode.queueName }));
        await registerFlowRecord(registry, flowId, 'dag', roots, refs);
        return c.json(
          {
            flowId,
            jobs: dag.nodes.map((dagNode) => ({
              id: jobs.get(dagNode.name)!.id,
              name: dagNode.name,
              queueName: dagNode.queueName,
            })),
            kind: 'dag',
            nodeCount: refs.length,
            roots,
          },
          201,
        );
      } finally {
        await producer.close().catch(() => undefined);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Internal server error';
      return c.json({ error: message }, errorStatus(error) as any);
    }
  });

  api.get('/flows/:id', async (c) => {
    try {
      const snapshot = await buildFlowSnapshot(getRegistry(c), c.req.param('id')!);
      if (!snapshot) {
        return c.json({ error: 'Flow not found' }, 404);
      }
      return c.json(snapshot);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Internal server error';
      return c.json({ error: message }, (message.includes('not accessible') ? 404 : errorStatus(error)) as any);
    }
  });

  api.get('/flows/:id/tree', async (c) => {
    try {
      const snapshot = await buildFlowSnapshot(getRegistry(c), c.req.param('id')!);
      if (!snapshot) {
        return c.json({ error: 'Flow not found' }, 404);
      }
      return c.json({
        budget: snapshot.budget,
        counts: snapshot.counts,
        createdAt: snapshot.createdAt,
        flowId: snapshot.flowId,
        kind: snapshot.kind,
        roots: snapshot.roots,
        tree: snapshot.tree,
        usage: snapshot.usage,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Internal server error';
      return c.json({ error: message }, (message.includes('not accessible') ? 404 : errorStatus(error)) as any);
    }
  });

  api.delete('/flows/:id', async (c) => {
    try {
      const registry = getRegistry(c);
      const flowId = c.req.param('id')!;
      const record = await loadFlowRecord(registry, flowId);
      if (!record) {
        return c.json({ error: 'Flow not found' }, 404);
      }
      assertAllowedFlowQueues(registry, record.jobs.map((job) => job.queueName));

      let revoked = 0;
      let flagged = 0;
      let skipped = 0;
      const jobs: Array<{ id: string; queueName: string; state?: string; status: string }> = [];

      for (const ref of record.jobs) {
        const { queue } = registry.get(ref.queueName);
        const job = await queue.getJob(ref.jobId);
        if (!job) {
          skipped += 1;
          jobs.push({ id: ref.jobId, queueName: ref.queueName, status: 'missing' });
          continue;
        }

        const state = await (job as any).getState();
        if (state === 'completed' || state === 'failed') {
          skipped += 1;
          jobs.push({ id: ref.jobId, queueName: ref.queueName, state, status: 'skipped' });
          continue;
        }

        const status = await (queue as any).revoke(ref.jobId);
        if (status === 'revoked') revoked += 1;
        else if (status === 'flagged') flagged += 1;
        else skipped += 1;
        jobs.push({ id: ref.jobId, queueName: ref.queueName, state, status });
      }

      await deleteFlowRecord(registry, flowId);
      return c.json({ flagged, flowId, jobs, revoked, skipped });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Internal server error';
      return c.json({ error: message }, (message.includes('not accessible') ? 404 : errorStatus(error)) as any);
    }
  });

  api.post('/broadcast/:name', async (c) => {
    const name = c.req.param('name')!;
    const accessError = ensureBroadcastAccess(name, allowedQueues);
    if (accessError) {
      return c.json({ error: accessError }, accessError === 'Invalid queue name' ? 400 : 404);
    }

    try {
      const registry = getRegistry(c);
      const body = await c.req.json<{ data?: unknown; opts?: Record<string, unknown>; subject?: unknown }>();

      if (typeof body?.subject !== 'string' || body.subject.trim() === '') {
        return c.json({ error: 'Validation failed', details: ['subject: Required'] }, 400);
      }

      const connection = getLiveConnection(registry, 'broadcast publish');
      const { Broadcast } = require('glide-mq') as typeof import('glide-mq');
      const broadcast = new Broadcast(name, {
        connection,
        prefix: registry.getPrefix(),
      });

      try {
        const rawOpts = body.opts ?? {};
        const safeOpts: Record<string, unknown> = {};
        for (const key of ALLOWED_JOB_OPTS) {
          if (key in rawOpts) safeOpts[key] = rawOpts[key];
        }

        const id = await broadcast.publish(body.subject, body.data ?? null, safeOpts as any);
        return c.json(id ? { id, subject: body.subject } : { skipped: true }, id ? 201 : 200);
      } finally {
        await broadcast.close().catch(() => undefined);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Internal server error';
      return c.json({ error: message }, errorStatus(error) as any);
    }
  });

  api.get('/broadcast/:name/events', (c) => {
    const name = c.req.param('name')!;
    const accessError = ensureBroadcastAccess(name, allowedQueues);
    if (accessError) {
      return c.json({ error: accessError }, accessError === 'Invalid queue name' ? 400 : 404);
    }

    const subscription = c.req.query('subscription');
    if (!subscription) {
      return c.json({ error: 'Missing required query param: subscription' }, 400);
    }

    const registry = getRegistry(c);
    if (!registry.getConnection()) {
      return c.json({ error: 'Connection config required for broadcast SSE' }, 500);
    }

    const { compileSubjectMatcher } = require('glide-mq') as typeof import('glide-mq');
    const matcher = compileSubjectMatcher(parseCsvParam(c.req.query('subjects')));

    return streamSSE(c, async (stream) => {
      const shared = await getSharedBroadcastStream(registry, name, subscription);
      const client: BroadcastClient = {
        matcher,
        stream,
      };
      let running = true;

      shared.clients.add(client);
      stream.onAbort(() => {
        running = false;
      });

      try {
        while (running) {
          await stream.writeSSE({
            event: 'heartbeat',
            data: JSON.stringify({ time: Date.now() }),
          });
          await stream.sleep(SSE_HEARTBEAT_MS);
        }
      } finally {
        removeBroadcastClient(shared, client);
      }
    });
  });

  api.use('/:name/*', guardQueue);
  api.use('/:name', guardQueue);

  if (schemas && zv) {
    api.post('/:name/jobs', zv('json', schemas.addJobSchema, onValidationError), async (c) => {
      const name = c.req.param('name')!;
      const registry = getRegistry(c);
      const { queue } = registry.get(name);
      const body = c.req.valid('json' as never) as { name: string; data: unknown; opts: Record<string, unknown> };

      const job = await queue.add(body.name, body.data, body.opts as any);
      if (!job) {
        return c.json({ error: 'Job deduplicated' }, 409);
      }
      return c.json(serializeJob(job), 201);
    });
  } else {
    api.post('/:name/jobs', async (c) => {
      const name = c.req.param('name')!;
      const registry = getRegistry(c);
      const { queue } = registry.get(name);
      const body = await c.req.json<{ name: string; data?: unknown; opts?: Record<string, unknown> }>();

      if (!body.name || typeof body.name !== 'string') {
        return c.json({ error: 'Validation failed', details: ['name: Required'] }, 400);
      }

      const rawOpts = body.opts ?? {};
      const safeOpts: Record<string, unknown> = {};
      for (const key of ALLOWED_JOB_OPTS) {
        if (key in rawOpts) safeOpts[key] = rawOpts[key];
      }
      const job = await queue.add(body.name, body.data ?? {}, safeOpts as any);
      if (!job) {
        return c.json({ error: 'Job deduplicated' }, 409);
      }
      return c.json(serializeJob(job), 201);
    });
  }

  if (schemas && zv) {
    api.get('/:name/jobs', zv('query', schemas.getJobsQuerySchema, onValidationError), async (c) => {
      const name = c.req.param('name')!;
      const registry = getRegistry(c);
      const { queue } = registry.get(name);

      const { type, start, end, excludeData } = c.req.valid('query' as never) as {
        type: string;
        start: number;
        end: number;
        excludeData?: boolean;
      };

      const jobs = await (queue as any).getJobs(type, start, end, excludeData ? { excludeData: true } : undefined);
      return c.json(serializeJobs(jobs));
    });
  } else {
    api.get('/:name/jobs', async (c) => {
      const name = c.req.param('name')!;
      const registry = getRegistry(c);
      const { queue } = registry.get(name);

      const VALID_JOB_TYPES = ['waiting', 'active', 'delayed', 'completed', 'failed'] as const;
      const typeParam = c.req.query('type') ?? 'waiting';

      if (!VALID_JOB_TYPES.includes(typeParam as any)) {
        return c.json(
          { error: 'Validation failed', details: [`type: must be one of ${VALID_JOB_TYPES.join(', ')}`] },
          400,
        );
      }

      const type = typeParam as (typeof VALID_JOB_TYPES)[number];
      const start = parseInt(c.req.query('start') ?? '0', 10);
      const end = parseInt(c.req.query('end') ?? '-1', 10);

      if (isNaN(start) || isNaN(end)) {
        return c.json({ error: 'Validation failed', details: ['start and end must be numbers'] }, 400);
      }

      const excludeData = c.req.query('excludeData') === 'true';
      const jobs = await (queue as any).getJobs(type, start, end, excludeData ? { excludeData: true } : undefined);
      return c.json(serializeJobs(jobs));
    });
  }

  api.get('/:name/jobs/:id', async (c) => {
    const name = c.req.param('name')!;
    const jobId = c.req.param('id')!;
    const registry = getRegistry(c);
    const { queue } = registry.get(name);

    const job = await queue.getJob(jobId);
    if (!job) {
      return c.json({ error: 'Job not found' }, 404);
    }
    return c.json(serializeJob(job));
  });

  api.get('/:name/counts', async (c) => {
    const name = c.req.param('name')!;
    const registry = getRegistry(c);
    const { queue } = registry.get(name);

    const counts = await queue.getJobCounts();
    return c.json(counts);
  });

  api.post('/:name/pause', async (c) => {
    const name = c.req.param('name')!;
    const registry = getRegistry(c);
    const { queue } = registry.get(name);

    await queue.pause();
    return c.body(null, 204);
  });

  api.post('/:name/resume', async (c) => {
    const name = c.req.param('name')!;
    const registry = getRegistry(c);
    const { queue } = registry.get(name);

    await queue.resume();
    return c.body(null, 204);
  });

  api.post('/:name/drain', async (c) => {
    const name = c.req.param('name')!;
    const registry = getRegistry(c);
    const { queue } = registry.get(name);

    await queue.drain();
    return c.body(null, 204);
  });

  if (schemas && zv) {
    api.post('/:name/retry', zv('json', schemas.retryBodySchema, onValidationError), async (c) => {
      const name = c.req.param('name')!;
      const registry = getRegistry(c);
      const { queue } = registry.get(name);

      const { count } = c.req.valid('json' as never) as { count?: number };

      const retried = await queue.retryJobs(count != null ? { count } : undefined);
      return c.json({ retried });
    });
  } else {
    api.post('/:name/retry', async (c) => {
      const name = c.req.param('name')!;
      const registry = getRegistry(c);
      const { queue } = registry.get(name);

      let count: number | undefined;
      try {
        const body = await c.req.json<{ count?: number }>();
        count = body.count;
      } catch {
        // No body or invalid JSON - retry all
      }

      if (count !== undefined && (!Number.isInteger(count) || count < 1)) {
        return c.json({ error: 'Validation failed', details: ['count must be a positive integer'] }, 400);
      }

      const retried = await queue.retryJobs(count != null ? { count } : undefined);
      return c.json({ retried });
    });
  }

  if (schemas && zv) {
    api.delete('/:name/clean', zv('query', schemas.cleanQuerySchema, onValidationError), async (c) => {
      const name = c.req.param('name')!;
      const registry = getRegistry(c);
      const { queue } = registry.get(name);

      const { grace, limit, type } = c.req.valid('query' as never) as { grace: number; limit: number; type: string };

      const removed = await queue.clean(grace, limit, type as any);
      return c.json({ removed: removed.length });
    });
  } else {
    api.delete('/:name/clean', async (c) => {
      const name = c.req.param('name')!;
      const registry = getRegistry(c);
      const { queue } = registry.get(name);

      const VALID_CLEAN_TYPES = ['completed', 'failed'] as const;
      const typeParam = c.req.query('type') ?? 'completed';

      if (!VALID_CLEAN_TYPES.includes(typeParam as any)) {
        return c.json(
          { error: 'Validation failed', details: [`type: must be one of ${VALID_CLEAN_TYPES.join(', ')}`] },
          400,
        );
      }

      const type = typeParam as (typeof VALID_CLEAN_TYPES)[number];
      const grace = parseInt(c.req.query('grace') ?? '0', 10);
      const limit = parseInt(c.req.query('limit') ?? '100', 10);

      if (isNaN(grace) || isNaN(limit) || grace < 0 || limit < 1) {
        return c.json({ error: 'Validation failed', details: ['grace must be >= 0 and limit must be >= 1'] }, 400);
      }

      const removed = await queue.clean(grace, limit, type);
      return c.json({ removed: removed.length });
    });
  }

  api.get('/:name/workers', async (c) => {
    const name = c.req.param('name')!;
    const registry = getRegistry(c);
    const { queue } = registry.get(name);

    const workers = await queue.getWorkers();
    return c.json(workers);
  });

  api.get('/:name/events', createEventsRoute());

  if (schemas && zv) {
    api.get('/:name/metrics', zv('query', schemas.metricsQuerySchema, onValidationError), async (c) => {
      const name = c.req.param('name')!;
      const registry = getRegistry(c);
      const { queue } = registry.get(name);

      const { type, start, end } = c.req.valid('query' as never) as { type: string; start: number; end: number };

      const metrics = await (queue as any).getMetrics(type, { start, end });
      return c.json(metrics);
    });
  } else {
    api.get('/:name/metrics', async (c) => {
      const name = c.req.param('name')!;
      const registry = getRegistry(c);
      const { queue } = registry.get(name);

      const VALID_METRIC_TYPES = ['completed', 'failed'] as const;
      const typeParam = c.req.query('type');

      if (!typeParam || !VALID_METRIC_TYPES.includes(typeParam as any)) {
        return c.json(
          { error: 'Validation failed', details: [`type: required, must be one of ${VALID_METRIC_TYPES.join(', ')}`] },
          400,
        );
      }

      const start = parseInt(c.req.query('start') ?? '0', 10);
      const end = parseInt(c.req.query('end') ?? '-1', 10);

      if (isNaN(start) || isNaN(end)) {
        return c.json({ error: 'Validation failed', details: ['start and end must be numbers'] }, 400);
      }

      const metrics = await (queue as any).getMetrics(typeParam, { start, end });
      return c.json(metrics);
    });
  }

  if (schemas && zv) {
    api.post('/:name/jobs/:id/priority', zv('json', schemas.changePriorityBodySchema, onValidationError), async (c) => {
      const name = c.req.param('name')!;
      const jobId = c.req.param('id')!;
      const registry = getRegistry(c);
      const { queue } = registry.get(name);

      const job = await queue.getJob(jobId);
      if (!job) {
        return c.json({ error: 'Job not found' }, 404);
      }

      const { priority } = c.req.valid('json' as never) as { priority: number };
      await (job as any).changePriority(priority);
      return c.body(null, 204);
    });
  } else {
    api.post('/:name/jobs/:id/priority', async (c) => {
      const name = c.req.param('name')!;
      const jobId = c.req.param('id')!;
      const registry = getRegistry(c);
      const { queue } = registry.get(name);

      const job = await queue.getJob(jobId);
      if (!job) {
        return c.json({ error: 'Job not found' }, 404);
      }

      const body = await c.req.json<{ priority?: number }>();
      if (body.priority == null || !Number.isInteger(body.priority) || body.priority < 0) {
        return c.json({ error: 'Validation failed', details: ['priority must be a non-negative integer'] }, 400);
      }

      await (job as any).changePriority(body.priority);
      return c.body(null, 204);
    });
  }

  if (schemas && zv) {
    api.post('/:name/jobs/:id/delay', zv('json', schemas.changeDelayBodySchema, onValidationError), async (c) => {
      const name = c.req.param('name')!;
      const jobId = c.req.param('id')!;
      const registry = getRegistry(c);
      const { queue } = registry.get(name);

      const job = await queue.getJob(jobId);
      if (!job) {
        return c.json({ error: 'Job not found' }, 404);
      }

      const { delay } = c.req.valid('json' as never) as { delay: number };
      await (job as any).changeDelay(delay);
      return c.body(null, 204);
    });
  } else {
    api.post('/:name/jobs/:id/delay', async (c) => {
      const name = c.req.param('name')!;
      const jobId = c.req.param('id')!;
      const registry = getRegistry(c);
      const { queue } = registry.get(name);

      const job = await queue.getJob(jobId);
      if (!job) {
        return c.json({ error: 'Job not found' }, 404);
      }

      const body = await c.req.json<{ delay?: number }>();
      if (body.delay == null || !Number.isInteger(body.delay) || body.delay < 0) {
        return c.json({ error: 'Validation failed', details: ['delay must be a non-negative integer'] }, 400);
      }

      await (job as any).changeDelay(body.delay);
      return c.body(null, 204);
    });
  }

  api.post('/:name/jobs/:id/promote', async (c) => {
    const name = c.req.param('name')!;
    const jobId = c.req.param('id')!;
    const registry = getRegistry(c);
    const { queue } = registry.get(name);

    const job = await queue.getJob(jobId);
    if (!job) {
      return c.json({ error: 'Job not found' }, 404);
    }

    await (job as any).promote();
    return c.body(null, 204);
  });

  api.get('/:name/schedulers', async (c) => {
    const name = c.req.param('name')!;
    const registry = getRegistry(c);
    const { queue } = registry.get(name);

    const schedulers = await (queue as any).getRepeatableJobs();
    return c.json(schedulers);
  });

  api.get('/:name/schedulers/:schedulerName', async (c) => {
    const name = c.req.param('name')!;
    const schedulerName = c.req.param('schedulerName');
    const registry = getRegistry(c);
    const { queue } = registry.get(name);

    const scheduler = await (queue as any).getJobScheduler(schedulerName);
    if (!scheduler) {
      return c.json({ error: 'Scheduler not found' }, 404);
    }
    return c.json(scheduler);
  });

  if (schemas && zv) {
    api.put(
      '/:name/schedulers/:schedulerName',
      zv('json', schemas.upsertSchedulerBodySchema, onValidationError),
      async (c) => {
        const name = c.req.param('name')!;
        const schedulerName = c.req.param('schedulerName');
        const registry = getRegistry(c);
        const { queue } = registry.get(name);

        const { schedule, template } = c.req.valid('json' as never) as {
          schedule: Record<string, unknown>;
          template?: Record<string, unknown>;
        };

        const result = await (queue as any).upsertJobScheduler(schedulerName, schedule, template);
        return c.json(result, 200);
      },
    );
  } else {
    api.put('/:name/schedulers/:schedulerName', async (c) => {
      const name = c.req.param('name')!;
      const schedulerName = c.req.param('schedulerName');
      const registry = getRegistry(c);
      const { queue } = registry.get(name);

      const body = await c.req.json<{ schedule?: Record<string, unknown>; template?: Record<string, unknown> }>();

      if (!body.schedule || typeof body.schedule !== 'object') {
        return c.json({ error: 'Validation failed', details: ['schedule: Required'] }, 400);
      }

      const result = await (queue as any).upsertJobScheduler(schedulerName, body.schedule, body.template);
      return c.json(result, 200);
    });
  }

  api.delete('/:name/schedulers/:schedulerName', async (c) => {
    const name = c.req.param('name')!;
    const schedulerName = c.req.param('schedulerName');
    const registry = getRegistry(c);
    const { queue } = registry.get(name);

    await (queue as any).removeJobScheduler(schedulerName);
    return c.body(null, 204);
  });

  if (schemas && zv) {
    api.post('/:name/jobs/wait', zv('json', schemas.addAndWaitBodySchema, onValidationError), async (c) => {
      const name = c.req.param('name')!;
      const registry = getRegistry(c);
      const { queue } = registry.get(name);

      const body = c.req.valid('json' as never) as {
        name: string;
        data: unknown;
        opts: Record<string, unknown>;
        waitTimeout?: number;
      };

      const { waitTimeout, ...rest } = body;
      const result = await (queue as any).addAndWait(rest.name, rest.data, {
        ...rest.opts,
        ...(waitTimeout != null ? { timeout: waitTimeout } : {}),
      });
      return c.json(result);
    });
  } else {
    api.post('/:name/jobs/wait', async (c) => {
      const name = c.req.param('name')!;
      const registry = getRegistry(c);
      const { queue } = registry.get(name);

      const body = await c.req.json<{
        name: string;
        data?: unknown;
        opts?: Record<string, unknown>;
        waitTimeout?: number;
      }>();

      if (!body.name || typeof body.name !== 'string') {
        return c.json({ error: 'Validation failed', details: ['name: Required'] }, 400);
      }

      const opts = body.opts ?? {};
      const result = await (queue as any).addAndWait(body.name, body.data ?? {}, {
        ...opts,
        ...(body.waitTimeout != null ? { timeout: body.waitTimeout } : {}),
      });
      return c.json(result);
    });
  }

  // GET /:name/flows/:id/usage - Aggregated usage across a flow
  api.get('/:name/flows/:id/usage', async (c) => {
    const name = c.req.param('name')!;
    const flowId = c.req.param('id')!;
    const registry = getRegistry(c);
    const { queue } = registry.get(name);

    const usage = await (queue as any).getFlowUsage(flowId);
    return c.json(usage);
  });

  // GET /:name/flows/:id/budget - Budget state for a flow
  api.get('/:name/flows/:id/budget', async (c) => {
    const name = c.req.param('name')!;
    const flowId = c.req.param('id')!;
    const registry = getRegistry(c);
    const { queue } = registry.get(name);

    const budget = await (queue as any).getFlowBudget(flowId);
    if (!budget) {
      return c.json({ error: 'No budget set for this flow' }, 404);
    }
    return c.json(budget);
  });

  // GET /:name/jobs/:id/stream - SSE stream of job streaming chunks
  api.get('/:name/jobs/:id/stream', (c) => {
    const name = c.req.param('name')!;
    const jobId = c.req.param('id')!;
    const registry = getRegistry(c);
    const { queue } = registry.get(name);

    return streamSSE(c, async (stream) => {
      let lastId = c.req.header('Last-Event-ID') || c.req.query('lastId') || undefined;
      let running = true;

      stream.onAbort(() => {
        running = false;
      });

      while (running) {
        const entries = await (queue as any).readStream(jobId, { lastId, count: 100 });
        for (const entry of entries) {
          await stream.writeSSE({
            id: entry.id,
            data: JSON.stringify(entry.fields),
          });
          lastId = entry.id;
        }

        const job = await queue.getJob(jobId);
        if (!job) break;
        const state = await (job as any).getState();
        if (state === 'completed' || state === 'failed') {
          const trailing = await (queue as any).readStream(jobId, { lastId, count: 100 });
          for (const entry of trailing) {
            await stream.writeSSE({
              id: entry.id,
              data: JSON.stringify(entry.fields),
            });
          }
          break;
        }

        await stream.sleep(500);
      }
    });
  });

  return api;
}

export type GlideMQApiType = ReturnType<typeof glideMQApi>;
