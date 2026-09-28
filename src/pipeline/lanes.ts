export async function inLanes<T>(
  jobs: readonly T[],
  width: number,
  run: (job: T, at: number) => Promise<void>,
): Promise<void> {
  const pending = new Set<Promise<void>>();
  let failure: { cause: unknown } | undefined;
  for (const [at, job] of jobs.entries()) {
    if (failure) break;
    const task: Promise<void> = run(job, at)
      .catch((error: unknown) => {
        failure ??= { cause: error };
      })
      .finally(() => pending.delete(task));
    pending.add(task);
    if (pending.size >= width) await Promise.race(pending);
  }
  await Promise.all(pending);
  if (failure) throw failure.cause;
}
