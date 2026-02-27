import { describe, it, expect, afterEach } from 'vitest';
import { QueueRegistryImpl } from '../src/registry';

describe('QueueRegistryImpl', () => {
  let registry: QueueRegistryImpl;

  afterEach(async () => {
    if (registry) await registry.closeAll();
  });

  it('throws if no connection and not testing', () => {
    expect(() => new QueueRegistryImpl({ queues: { q: {} } })).toThrow(
      'connection is required',
    );
  });

  it('creates registry in testing mode without connection', () => {
    registry = new QueueRegistryImpl({ queues: { q: {} }, testing: true });
    expect(registry.testing).toBe(true);
  });

  it('lists configured queue names', () => {
    registry = new QueueRegistryImpl({
      queues: { emails: {}, reports: {} },
      testing: true,
    });
    expect(registry.names()).toEqual(['emails', 'reports']);
  });

  it('has() returns true for configured queues', () => {
    registry = new QueueRegistryImpl({
      queues: { emails: {} },
      testing: true,
    });
    expect(registry.has('emails')).toBe(true);
    expect(registry.has('unknown')).toBe(false);
  });

  it('get() creates a TestQueue lazily', () => {
    registry = new QueueRegistryImpl({
      queues: { emails: {} },
      testing: true,
    });

    const managed = registry.get('emails');
    expect(managed.queue).toBeDefined();
    expect(managed.worker).toBeNull();
  });

  it('get() creates a TestWorker when processor is provided', () => {
    registry = new QueueRegistryImpl({
      queues: {
        emails: {
          processor: async (job) => ({ sent: true }),
        },
      },
      testing: true,
    });

    const managed = registry.get('emails');
    expect(managed.queue).toBeDefined();
    expect(managed.worker).toBeDefined();
  });

  it('get() returns same instance on repeated calls', () => {
    registry = new QueueRegistryImpl({
      queues: { emails: {} },
      testing: true,
    });

    const first = registry.get('emails');
    const second = registry.get('emails');
    expect(first).toBe(second);
  });

  it('get() throws for unconfigured queue', () => {
    registry = new QueueRegistryImpl({
      queues: { emails: {} },
      testing: true,
    });

    expect(() => registry.get('unknown')).toThrow('not configured');
  });

  it('closeAll() prevents further get() calls', async () => {
    registry = new QueueRegistryImpl({
      queues: { emails: {} },
      testing: true,
    });

    // Initialize the queue
    registry.get('emails');

    await registry.closeAll();
    expect(() => registry.get('emails')).toThrow('closed');
  });

  it('closeAll() is idempotent', async () => {
    registry = new QueueRegistryImpl({
      queues: { emails: {} },
      testing: true,
    });

    await registry.closeAll();
    await registry.closeAll(); // Should not throw
  });
});
