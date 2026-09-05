/** Bound read-only work, including waits for the auth lock before fetch starts.
 * Never use this to retry writes: a timed-out send may already have succeeded.
 */
export async function readWithTimeout<T>(
  read: (signal: AbortSignal) => PromiseLike<T>,
  parentSignal?: AbortSignal,
  timeoutMs = 12_000,
): Promise<T> {
  const controller = new AbortController();
  const cancel = () => controller.abort(new Error('Read cancelled'));
  if (parentSignal?.aborted) cancel();
  else parentSignal?.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(
    () => controller.abort(new Error('Loading timed out. Please try again.')),
    timeoutMs,
  );
  let rejectAbort: () => void = () => {};
  try {
    const aborted = new Promise<never>((_, reject) => {
      rejectAbort = () => reject(controller.signal.reason);
      controller.signal.addEventListener('abort', rejectAbort, { once: true });
      if (controller.signal.aborted) rejectAbort();
    });
    const result = Promise.resolve().then(() => {
      controller.signal.throwIfAborted();
      return read(controller.signal);
    });
    return await Promise.race([result, aborted]);
  } finally {
    clearTimeout(timer);
    parentSignal?.removeEventListener('abort', cancel);
    controller.signal.removeEventListener('abort', rejectAbort);
  }
}
