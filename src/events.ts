import type { WatchStateEvent } from '@aiostreams/addon-sdk';

/** When the event happened, in milliseconds: never in the future, and now when the event has no usable time. */
export function stampOf(event: WatchStateEvent, nowMs: number): number {
  const at = Number(event.at) * 1000;
  return Number.isFinite(at) && at > 0 ? Math.min(at, nowMs) : nowMs;
}

/** A watched mark, or a play that got past AIOStreams' played threshold. */
export function isFinished(event: WatchStateEvent): boolean {
  return (
    event.event === 'played' ||
    (event.event === 'stop' && event.played === true)
  );
}
