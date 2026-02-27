import type { Queue, Worker, Job, ConnectionOptions } from 'glide-mq';

// --- Config ---

export interface QueueConfig<D = any, R = any> {
  /** Worker processor function. If omitted, queue is producer-only. */
  processor?: (job: Job<D, R>) => Promise<R>;
  /** Worker concurrency. Default: 1 */
  concurrency?: number;
  /** Additional worker options passed through to glide-mq Worker constructor */
  workerOpts?: Record<string, unknown>;
}

export interface GlideMQConfig {
  /** Valkey/Redis connection options. Required unless testing: true. */
  connection?: ConnectionOptions;
  /** Queue definitions keyed by name */
  queues: Record<string, QueueConfig>;
  /** Key prefix for all queues. Default: 'glide' */
  prefix?: string;
  /** Enable in-memory testing mode (no Valkey needed) */
  testing?: boolean;
}

// --- Registry ---

export interface ManagedQueue<D = any, R = any> {
  queue: Queue<D, R>;
  worker: Worker<D, R> | null;
}

export interface QueueRegistry {
  /** Get or lazily create a managed queue by name */
  get<D = any, R = any>(name: string): ManagedQueue<D, R>;
  /** Check if a queue name is configured */
  has(name: string): boolean;
  /** List all configured queue names */
  names(): string[];
  /** Close all queues and workers */
  closeAll(): Promise<void>;
  /** Whether testing mode is active */
  readonly testing: boolean;
  /** Get the connection options (undefined in testing mode) */
  getConnection(): ConnectionOptions | undefined;
  /** Get the key prefix */
  getPrefix(): string | undefined;
}

// --- API Config ---

export interface GlideMQApiConfig {
  /** Route prefix for API endpoints. Default: '' */
  prefix?: string;
  /** Restrict API to specific queue names. Default: all configured queues. */
  queues?: string[];
}

// --- Hono Env ---

export interface GlideMQEnv {
  Variables: {
    glideMQ: QueueRegistry;
  };
}

// --- Job serialization ---

export interface JobResponse {
  id: string;
  name: string;
  data: unknown;
  opts: Record<string, unknown>;
  attemptsMade: number;
  returnvalue: unknown;
  failedReason: string | undefined;
  progress: number | object;
  timestamp: number;
  finishedOn: number | undefined;
  processedOn: number | undefined;
}

export interface JobCountsResponse {
  waiting: number;
  active: number;
  delayed: number;
  completed: number;
  failed: number;
}

export interface WorkerInfoResponse {
  id: string;
  addr: string;
  pid: number;
  startedAt: number;
  age: number;
  activeJobs: number;
}
