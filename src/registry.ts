import type { Queue, Worker, ConnectionOptions } from 'glide-mq';
import type { GlideMQConfig, QueueConfig, QueueRegistry, ManagedQueue } from './types';

export class QueueRegistryImpl implements QueueRegistry {
  private readonly config: GlideMQConfig;
  private readonly managed = new Map<string, ManagedQueue>();
  private closed = false;

  constructor(config: GlideMQConfig) {
    this.config = config;
    if (!config.testing && !config.connection) {
      throw new Error('GlideMQ: connection is required when testing mode is disabled');
    }
  }

  get testing(): boolean {
    return this.config.testing === true;
  }

  has(name: string): boolean {
    return name in this.config.queues;
  }

  names(): string[] {
    return Object.keys(this.config.queues);
  }

  get<D = any, R = any>(name: string): ManagedQueue<D, R> {
    if (this.closed) {
      throw new Error(`GlideMQ: registry is closed`);
    }

    const existing = this.managed.get(name);
    if (existing) return existing as ManagedQueue<D, R>;

    const queueConfig = this.config.queues[name];
    if (!queueConfig) {
      throw new Error(`GlideMQ: queue "${name}" is not configured`);
    }

    const entry = this.config.testing
      ? this.createTestEntry<D, R>(name, queueConfig)
      : this.createEntry<D, R>(name, queueConfig);

    this.managed.set(name, entry as ManagedQueue);
    return entry;
  }

  private createEntry<D, R>(name: string, config: QueueConfig<D, R>): ManagedQueue<D, R> {
    const { Queue: QueueClass, Worker: WorkerClass } = require('glide-mq') as {
      Queue: new (name: string, opts: any) => Queue<D, R>;
      Worker: new (name: string, processor: any, opts: any) => Worker<D, R>;
    };

    const queueOpts = {
      connection: this.config.connection!,
      prefix: this.config.prefix,
    };

    const queue = new QueueClass(name, queueOpts);
    let worker: Worker<D, R> | null = null;

    if (config.processor) {
      worker = new WorkerClass(name, config.processor, {
        ...queueOpts,
        concurrency: config.concurrency ?? 1,
        ...config.workerOpts,
      });
    }

    return { queue, worker };
  }

  private createTestEntry<D, R>(name: string, config: QueueConfig<D, R>): ManagedQueue<D, R> {
    const { TestQueue, TestWorker } = require('glide-mq/testing') as {
      TestQueue: new (name: string) => any;
      TestWorker: new (queue: any, processor: any, opts?: any) => any;
    };

    const queue = new TestQueue(name);
    let worker: any = null;

    if (config.processor) {
      worker = new TestWorker(queue, config.processor, {
        concurrency: config.concurrency ?? 1,
      });
    }

    return { queue, worker };
  }

  getConnection(): ConnectionOptions | undefined {
    return this.config.connection;
  }

  getPrefix(): string | undefined {
    return this.config.prefix;
  }

  async closeAll(): Promise<void> {
    if (this.closed) return;
    this.closed = true;

    const closeOps: Promise<void>[] = [];
    for (const { queue, worker } of this.managed.values()) {
      if (worker) closeOps.push(worker.close());
      closeOps.push(queue.close());
    }
    await Promise.allSettled(closeOps);
    this.managed.clear();
  }
}
