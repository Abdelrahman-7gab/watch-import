import { createLogger, type WatchStateEvent } from '@aiostreams/addon-sdk';
import type { StremioConfig } from '../config.js';
import { libraryGetIds, libraryPut } from './api.js';
import { normaliseItem, type LibraryItem } from './library-item.js';
import { bitfieldOrder, MetaNotFound, resolveMeta, type Meta } from './meta.js';
import { WatchedBitField } from './watched.js';

const logger = createLogger('stremio-push');

/** Stremio's marker for "the next episode is up": an offset of 1 ms on its video. */
const NEXT_EPISODE_OFFSET = 1;
/** Positions under this are a start that never got going; Stremio would not resume there either. */
const MIN_RESUME_MS = 1000;

const iso = (ms: number) => new Date(ms).toISOString();

function stampOf(event: WatchStateEvent, nowMs: number): number {
  const at = Number(event.at) * 1000;
  return Number.isFinite(at) && at > 0 ? Math.min(at, nowMs) : nowMs;
}

/** A library item for a title the account has never opened: kept out of the library, as Stremio does. */
export function newItem(meta: Meta, type: string, nowMs: number): LibraryItem {
  return {
    _id: meta.id,
    name: meta.name ?? meta.id,
    type,
    poster: meta.poster ?? null,
    posterShape: 'poster',
    removed: true,
    temp: true,
    _ctime: iso(nowMs),
    _mtime: iso(nowMs),
    state: {
      lastWatched: null,
      timeWatched: 0,
      timeOffset: 0,
      overallTimeWatched: 0,
      timesWatched: 0,
      flaggedWatched: 0,
      duration: 0,
      video_id: null,
      watched: null,
      noNotif: false,
    },
    behaviorHints: {
      defaultVideoId: null,
      featuredVideoId: null,
      hasScheduledVideos: false,
    },
  };
}

/** Marks or clears episodes in the item's watched field; false when the meta is unknown. */
function markEpisodes(
  item: LibraryItem,
  meta: Meta | null,
  videoIds: string[],
  watched: boolean
): boolean {
  if (!meta) return false;
  const field = WatchedBitField.decode(item.state.watched, bitfieldOrder(meta));
  let changed = false;
  for (const id of videoIds) changed = field.setVideo(id, watched) || changed;
  if (changed) item.state.watched = field.encode();
  return changed;
}

/** The episode after `videoId` in Stremio's order, if any. */
function nextEpisode(meta: Meta | null, videoId: string): string | null {
  if (!meta) return null;
  const order = bitfieldOrder(meta);
  const at = order.indexOf(videoId);
  return at === -1 || at + 1 >= order.length ? null : order[at + 1];
}

/**
 * The library item after `event`, or null when the event changes nothing
 * Stremio shows. `meta` is needed for episodes' watched marks and the next
 * episode; without it only the resume point and dates change.
 */
export function applyEvent(
  current: LibraryItem,
  event: WatchStateEvent,
  meta: Meta | null,
  nowMs: number
): LibraryItem | null {
  const item = normaliseItem(structuredClone(current));
  const state = item.state;
  const when = iso(stampOf(event, nowMs));
  const finished =
    event.event === 'played' ||
    (event.event === 'stop' && event.played === true);

  switch (event.event) {
    case 'start':
    case 'pause':
    case 'stop': {
      if (finished) break;
      if (!(event.positionMs >= MIN_RESUME_MS)) return null;
      state.timeOffset = Math.round(event.positionMs);
      if (event.durationMs && event.durationMs > 0)
        state.duration = Math.round(event.durationMs);
      state.lastWatched = when;
      if (event.scope === 'episode') state.video_id = event.videoId;
      // Not in the library: Continue Watching still lists a temporary item.
      if (item.removed) item.temp = true;
      break;
    }
    case 'played':
    case 'unplayed':
      break;
    case 'watchlisted':
      item.removed = false;
      item.temp = false;
      break;
    case 'unwatchlisted':
      item.removed = true;
      break;
    default:
      return null;
  }

  if (event.event === 'played' || event.event === 'unplayed' || finished) {
    const watched = finished;
    if (event.scope === 'season' || event.scope === 'series') {
      if (
        !markEpisodes(
          item,
          meta,
          event.videos.map((v) => v.videoId),
          watched
        )
      )
        return null;
    } else if (event.scope === 'movie') {
      state.flaggedWatched = watched ? 1 : 0;
      state.timesWatched = watched ? state.timesWatched + 1 : 0;
      if (watched) {
        state.timeOffset = 0;
        state.lastWatched = when;
      }
    } else if ('videoId' in event) {
      markEpisodes(item, meta, [event.videoId], watched);
      if (watched) {
        state.lastWatched = when;
        const next =
          event.event === 'stop' ? nextEpisode(meta, event.videoId) : null;
        if (next) {
          // Stremio's own "next episode" entry in Continue Watching.
          state.video_id = next;
          state.timeOffset = NEXT_EPISODE_OFFSET;
          state.duration = 0;
          if (item.removed) item.temp = true;
        } else {
          state.video_id = event.videoId;
          state.timeOffset = 0;
        }
      }
    }
  }

  item._mtime = iso(nowMs);
  return item;
}

/** Events that need the title's meta: to create its item, or to mark episodes. */
function needsMeta(event: WatchStateEvent): boolean {
  if (event.event === 'played' || event.event === 'unplayed')
    return event.scope !== 'movie';
  return (
    event.event === 'stop' && event.played === true && event.scope === 'episode'
  );
}

async function metaFor(
  authKey: string,
  event: WatchStateEvent
): Promise<Meta | null> {
  const types = event.scope === 'movie' ? ['movie'] : ['series', 'anime'];
  for (const type of types) {
    try {
      return await resolveMeta(authKey, type, event.metaId);
    } catch (error) {
      if (!(error instanceof MetaNotFound)) throw error;
    }
  }
  return null;
}

/** One write at a time per title, so a quick pause after a start never loses either. */
const queues = new Map<string, Promise<unknown>>();

function serially<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = queues.get(key) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(task);
  queues.set(key, next);
  void next.finally(() => {
    if (queues.get(key) === next) queues.delete(key);
  });
  return next;
}

/** Writes an AIOStreams event into the account's Stremio library. */
export function pushToStremio(
  config: StremioConfig,
  event: WatchStateEvent,
  nowMs: () => number = Date.now
): Promise<void> {
  if (event.event === 'dropped' || event.event === 'undropped')
    return Promise.resolve();
  if (event.event === 'rated' || event.event === 'unrated')
    return Promise.resolve();
  return serially(`${config.authKey}\0${event.metaId}`, async () => {
    const [found] = await libraryGetIds(config.authKey, [event.metaId]);
    const removing =
      event.event === 'unplayed' || event.event === 'unwatchlisted';
    if (!found && removing) return;
    const meta =
      !found || needsMeta(event) ? await metaFor(config.authKey, event) : null;
    if (!found && !meta) {
      logger.warn(
        { id: event.metaId },
        'no meta for a title Stremio has never seen; skipped'
      );
      return;
    }
    const type = event.scope === 'movie' ? 'movie' : (meta?.type ?? 'series');
    const base = found ?? newItem(meta!, type, nowMs());
    const next = applyEvent(base, event, meta, nowMs());
    if (!next) return;
    await libraryPut(config.authKey, [next]);
    logger.debug(
      { id: event.metaId, event: event.event },
      'written to Stremio'
    );
  });
}
