/** One write at a time per key, so a quick pause after a start never loses either. */
const queues = new Map<string, Promise<unknown>>();

/**
 * Runs `task` after the key's earlier tasks settle. Its failure reaches the
 * caller only: the queue's own bookkeeping never leaves a rejection unhandled.
 */
export function serially<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = queues.get(key) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(task);
  queues.set(key, next);
  const forget = () => {
    if (queues.get(key) === next) queues.delete(key);
  };
  next.then(forget, forget);
  return next;
}
