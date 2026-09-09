export type ParallelExecutionResult<T> = { results: Array<{ index: number; status: 'fulfilled'; value: T } | { index: number; status: 'rejected'; reason: string }>; fulfilled: number; rejected: number };

/** Runs independent candidates concurrently while isolating failures. */
export async function executeParallel<T>(tasks: Array<() => Promise<T>>, maxAgents = Number(process.env.MAX_PARALLEL_AGENTS || 4)): Promise<ParallelExecutionResult<T>> {
  const limit = Math.max(1, Math.min(16, Number(maxAgents) || 1));
  const results: ParallelExecutionResult<T>['results'] = [];
  let cursor = 0;
  const worker = async () => {
    while (cursor < tasks.length) {
      const index = cursor++;
      try { results[index] = { index, status: 'fulfilled', value: await tasks[index]() }; }
      catch (error) { results[index] = { index, status: 'rejected', reason: error instanceof Error ? error.message : String(error) }; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
  return { results, fulfilled: results.filter((result) => result.status === 'fulfilled').length, rejected: results.filter((result) => result.status === 'rejected').length };
}
