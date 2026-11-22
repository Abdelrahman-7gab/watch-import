import { createLogger, type WatchStateEvent } from '@aiostreams/addon-sdk';
import type { StremioConfig } from '../config.js';
import { libraryGetIds, libraryPut } from './api.js';
import { isFinished, stampOf } from '../events.js';
import { normaliseItem, timeOf, type LibraryItem } from './library-item.js';
import { bitfieldOrder, MetaNotFound, resolveMeta, type Meta } from './meta.js';
import { serially } from '../serially.js';
import { WatchedBitField } from './watched.js';

const logger = createLogger('stremio-push');

/** Stremio's marker for "the next episode is up": an offset of 1 ms on its video. */
const NEXT_EPISODE_OFFSET = 1;
/** Positions under this are a start that never got going; Stremio would not resume there either. */
const MIN_RESUME_MS = 1000;

const iso = (ms: number) => new Date(ms).toISOString();

/** A playback event that cannot change anything: not finished, and too early to resume. */
const tooEarly = (event: WatchStateEvent) =>
  (event.event === 'start' ||
    event.event === 'pause' ||
    event.event === 'stop') &&
  !isFinished(event) &&
  !(event.positionMs >= MIN_RESUME_MS);

/**
 * A library item for a title the account has never opened: kept out of the
 * library, as Stremio does. Filed under `id`, the id the event and the
 * library lookup use, which an addon's meta may spell differently.
 */
export function newItem(
  meta: Meta,
  type: string,
  nowMs: number,
  id: string = meta.id
): LibraryItem {
  return {
    _id: id,
    name: meta.name ?? id,
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

/**
 * Marks or clears episodes in the item's watched field. False when nothing
 * changed: the meta is unknown, the marks were already so, or the stored field
 * cannot be lined up with the meta (rewriting it would wipe the show's history).
 */
function markEpisodes(
  item: LibraryItem,
  meta: Meta | null,
  videoIds: string[],
  watched: boolean
): boolean {
  if (!meta) return false;
  const field = WatchedBitField.read(item.state.watched, bitfieldOrder(meta));
  if (!field) {
    logger.warn(
      { id: item._id },
      'watched marks do not line up with the meta; left as they are'
    );
    return false;
  }
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
  const stamp = stampOf(event, nowMs);
  const when = iso(stamp);
  const finished = isFinished(event);
  // A late or retried event never replaces newer playback: its resume point,
  // next episode, date and count stay. A late finish still marks what it watched.
  const stale = timeOf(state.lastWatched) > stamp;

  switch (event.event) {
    case 'start':
    case 'pause':
    case 'stop': {
      if (finished) break;
      if (tooEarly(event)) return null;
      if (stale) return null;
      state.timeOffset = Math.round(event.positionMs);
      if (event.durationMs && event.durationMs > 0)
        state.duration = Math.round(event.durationMs);
      state.lastWatched = when;
      state.video_id = event.videoId;
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

  if (
    event.event === 'played' ||
    event.event === 'unplayed' ||
    (event.event === 'stop' && finished)
  ) {
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
      if (!watched) {
        state.flaggedWatched = 0;
        state.timesWatched = 0;
      } else if (stale) {
        if (state.flaggedWatched === 1) return null;
        state.flaggedWatched = 1;
      } else {
        // A viewing counts once: a watched mark after the finished play, or
        // the same finish retried, is the same one.
        const counted =
          state.flaggedWatched === 1 &&
          (event.event === 'played' || timeOf(state.lastWatched) >= stamp);
        state.flaggedWatched = 1;
        state.timesWatched += counted ? 0 : 1;
        state.timeOffset = 0;
        state.lastWatched = when;
      }
    } else if ('videoId' in event) {
      const marked = markEpisodes(item, meta, [event.videoId], watched);
      if (event.event !== 'stop') {
        // A mark, not the end of a play: only the episode being resumed leaves Continue Watching.
        if (!marked) return null;
        if (watched && !stale && state.video_id === event.videoId)
          state.timeOffset = 0;
      } else if (stale) {
        if (!marked) return null;
      } else {
        state.lastWatched = when;
        const next = nextEpisode(meta, event.videoId);
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

  // Stremio keeps the copy with the newest _mtime, so never stamp one older than the stored copy.
  item._mtime = iso(Math.max(nowMs, timeOf(current._mtime) + 1));
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
  // Before any round trip: a start that never got going costs Stremio nothing.
  if (tooEarly(event)) return Promise.resolve();
  return serially(`stremio\0${config.authKey}\0${event.metaId}`, async () => {
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
    const base = found ?? newItem(meta!, type, nowMs(), event.metaId);
    const next = applyEvent(base, event, meta, nowMs());
    if (!next) return;
    await libraryPut(config.authKey, [next]);
    logger.debug(
      { id: event.metaId, event: event.event },
      'written to Stremio'
    );
  });
}
