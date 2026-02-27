import { describe, it, expect } from 'vitest';
import { buildSchemas, hasZod } from '../src/schemas';

describe('schemas', () => {
  it('hasZod returns true (zod is a devDep)', () => {
    expect(hasZod()).toBe(true);
  });

  it('buildSchemas returns all schemas', () => {
    const schemas = buildSchemas();
    expect(schemas).not.toBeNull();
    expect(schemas!.addJobSchema).toBeDefined();
    expect(schemas!.getJobsQuerySchema).toBeDefined();
    expect(schemas!.cleanQuerySchema).toBeDefined();
    expect(schemas!.retryBodySchema).toBeDefined();
  });

  describe('addJobSchema', () => {
    const schemas = buildSchemas()!;

    it('validates a correct job', () => {
      const result = schemas.addJobSchema.safeParse({
        name: 'email',
        data: { to: 'user@test.com' },
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.name).toBe('email');
        expect(result.data.data).toEqual({ to: 'user@test.com' });
        expect(result.data.opts).toEqual({});
      }
    });

    it('rejects missing name', () => {
      const result = schemas.addJobSchema.safeParse({ data: {} });
      expect(result.success).toBe(false);
    });

    it('rejects empty name', () => {
      const result = schemas.addJobSchema.safeParse({ name: '', data: {} });
      expect(result.success).toBe(false);
    });

    it('defaults data to {} when omitted', () => {
      const result = schemas.addJobSchema.safeParse({ name: 'test' });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.data).toEqual({});
      }
    });

    it('accepts opts with delay and priority', () => {
      const result = schemas.addJobSchema.safeParse({
        name: 'test',
        opts: { delay: 5000, priority: 1 },
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.opts).toEqual({ delay: 5000, priority: 1 });
      }
    });
  });

  describe('getJobsQuerySchema', () => {
    const schemas = buildSchemas()!;

    it('applies defaults', () => {
      const result = schemas.getJobsQuerySchema.safeParse({});
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.type).toBe('waiting');
        expect(result.data.start).toBe(0);
        expect(result.data.end).toBe(-1);
      }
    });

    it('coerces string numbers', () => {
      const result = schemas.getJobsQuerySchema.safeParse({ start: '5', end: '10' });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.start).toBe(5);
        expect(result.data.end).toBe(10);
      }
    });

    it('rejects invalid type', () => {
      const result = schemas.getJobsQuerySchema.safeParse({ type: 'invalid' });
      expect(result.success).toBe(false);
    });

    it('accepts all valid types', () => {
      for (const type of ['waiting', 'active', 'delayed', 'completed', 'failed']) {
        const result = schemas.getJobsQuerySchema.safeParse({ type });
        expect(result.success).toBe(true);
      }
    });
  });

  describe('cleanQuerySchema', () => {
    const schemas = buildSchemas()!;

    it('applies defaults', () => {
      const result = schemas.cleanQuerySchema.safeParse({});
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.grace).toBe(0);
        expect(result.data.limit).toBe(100);
        expect(result.data.type).toBe('completed');
      }
    });

    it('rejects invalid type', () => {
      const result = schemas.cleanQuerySchema.safeParse({ type: 'waiting' });
      expect(result.success).toBe(false);
    });
  });

  describe('retryBodySchema', () => {
    const schemas = buildSchemas()!;

    it('allows empty body', () => {
      const result = schemas.retryBodySchema.safeParse({});
      expect(result.success).toBe(true);
    });

    it('parses count', () => {
      const result = schemas.retryBodySchema.safeParse({ count: 10 });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.count).toBe(10);
      }
    });
  });
});
