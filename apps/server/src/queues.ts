import { Queue } from 'bullmq';
import { config } from './config.js';

export const queueNames = ['discovery', 'filter', 'crawl', 'qualify', 'research', 'enrich', 'campaign'] as const;
export type QueueName = typeof queueNames[number];

const redisUrl = new URL(config.REDIS_URL);
export const connection = {
  host: redisUrl.hostname,
  port: Number(redisUrl.port || 6379),
  username: redisUrl.username || undefined,
  password: redisUrl.password || undefined,
  db: Number(redisUrl.pathname.slice(1) || 0),
};

const defaultJobOptions = {
  attempts: 3,
  backoff: { type: 'exponential' as const, delay: 2_000 },
  removeOnComplete: { age: 86_400, count: 5_000 },
  removeOnFail: { age: 604_800, count: 10_000 },
};

export const queues = Object.fromEntries(
  queueNames.map((name) => [name, new Queue(name, { connection, defaultJobOptions })]),
) as Record<QueueName, Queue>;

export async function enqueue(name: QueueName, jobName: string, data: Record<string, unknown>, deduplicationId?: string) {
  return queues[name].add(jobName, data, {
    ...(deduplicationId ? { deduplication: { id: deduplicationId } } : {}),
  });
}

export async function queueSnapshot() {
  const entries = await Promise.all(queueNames.map(async (name) => {
    const counts = await queues[name].getJobCounts('waiting', 'active', 'completed', 'failed', 'delayed');
    return [name, counts] as const;
  }));
  return Object.fromEntries(entries);
}

export async function cancelRunJobs(runId: string) {
  let removed = 0;
  for (const queue of Object.values(queues)) {
    const jobs = await queue.getJobs(['waiting', 'delayed', 'prioritized', 'paused'], 0, -1, true);
    for (const job of jobs) {
      if (job.data?.runId !== runId) continue;
      await job.remove();
      removed += 1;
    }
  }
  return removed;
}

export async function closeQueues() {
  await Promise.all(Object.values(queues).map((queue) => queue.close()));
}
