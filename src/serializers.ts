import type { Job } from 'glide-mq';
import type { JobResponse } from './types';

/**
 * Convert a glide-mq Job instance to a plain JSON-safe object.
 */
export function serializeJob(job: Job): JobResponse {
  const result: JobResponse = {
    id: job.id,
    name: job.name,
    data: job.data,
    opts: job.opts as Record<string, unknown>,
    attemptsMade: job.attemptsMade,
    returnvalue: job.returnvalue,
    failedReason: job.failedReason,
    progress: job.progress,
    timestamp: job.timestamp,
    finishedOn: job.finishedOn,
    processedOn: job.processedOn,
  };

  const jobAny = job as any;
  if (jobAny.parentId != null) result.parentId = jobAny.parentId;
  if (jobAny.parentQueue != null) result.parentQueue = jobAny.parentQueue;
  if (jobAny.orderingKey != null) result.orderingKey = jobAny.orderingKey;
  if (jobAny.cost != null) result.cost = jobAny.cost;
  if (jobAny.schedulerName != null) result.schedulerName = jobAny.schedulerName;

  return result;
}

/**
 * Serialize an array of jobs.
 */
export function serializeJobs(jobs: Job[]): JobResponse[] {
  return jobs.map(serializeJob);
}
