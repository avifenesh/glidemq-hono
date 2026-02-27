import type { Job } from 'glide-mq';
import type { JobResponse } from './types';

/**
 * Convert a glide-mq Job instance to a plain JSON-safe object.
 */
export function serializeJob(job: Job): JobResponse {
  return {
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
}

/**
 * Serialize an array of jobs.
 */
export function serializeJobs(jobs: Job[]): JobResponse[] {
  return jobs.map(serializeJob);
}
