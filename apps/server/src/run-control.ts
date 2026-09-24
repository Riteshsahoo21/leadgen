export class RunPausedError extends Error {
  constructor() { super('Run is paused'); }
}

export function runIsStopped(status: string | undefined): boolean {
  if (status === 'paused') throw new RunPausedError();
  return !status || status === 'cancelled' || status === 'failed';
}
