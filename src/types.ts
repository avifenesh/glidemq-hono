import type { Queue, Worker, Job, Producer, ConnectionOptions, Serializer } from 'glide-mq';

// --- Config ---

export interface QueueConfig<D = any, R = any> {
  /** Worker processor function. If omitted, queue is producer-only. */
  processor?: (job: Job<D, R>) => Promise<R>;
  /** Worker concurrency. Default: 1 */
  concurrency?: number;
  /** Additional worker options passed through to glide-mq Worker constructor */
  workerOpts?: Record<string, unknown>;
}

export interface ProducerConfig {
  /** Enable transparent compression of job data. Default: 'none'. */
  compression?: 'none' | 'gzip';
  /** Custom serializer for job data. Default: JSON. */
  serializer?: Serializer;
}

export interface GlideMQConfig {
  /** Valkey/Redis connection options. Required unless testing: true. */
  connection?: ConnectionOptions;
  /** Queue definitions keyed by name */
  queues?: Record<string, QueueConfig>;
  /** Lightweight producer definitions keyed by name (serverless/edge) */
  producers?: Record<string, ProducerConfig>;
  /** Key prefix for all queues. Default: 'glide' */
  prefix?: string;
  /** Enable in-memory testing mode (no Valkey needed) */
  testing?: boolean;
  /** Custom serializer for job data. Default: JSON. */
  serializer?: Serializer;
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
  /** Get or lazily create a Producer by name */
  getProducer<D = any>(name: string): Producer<D>;
  /** Check if a producer name is configured */
  hasProducer(name: string): boolean;
  /** List all configured producer names */
  producerNames(): string[];
  /** Close all queues, workers, and producers */
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
  /** Restrict API to specific queue names. Default: all configured queues. */
  queues?: string[];
  /** Restrict produce API to specific producer names. Default: all configured producers. */
  producers?: string[];
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
  parentId?: string;
  parentQueue?: string;
  orderingKey?: string;
  cost?: number;
  schedulerName?: string;
  usage?: {
    model?: string;
    provider?: string;
    tokens?: Record<string, number>;
    totalTokens?: number;
    costs?: Record<string, number>;
    totalCost?: number;
    costUnit?: string;
    latencyMs?: number;
    cached?: boolean;
  };
  signals?: Array<{ name: string; data: any; receivedAt: number }>;
  budgetKey?: string;
  fallbackIndex?: number;
  tpmTokens?: number;
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
