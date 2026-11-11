/** Runs every step in order, awaiting each and continuing past failures; rejects with an AggregateError of the failures in step order. */
export async function runCleanup(label: string, steps: readonly (() => unknown)[]): Promise<void> {
  const failures: unknown[] = [];
  for (const step of steps) {
    try {
      await step();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) throw new AggregateError(failures, `${label} cleanup failed`);
}
