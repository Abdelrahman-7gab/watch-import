import { createLogger, type WatchStateEvent } from '@aiostreams/addon-sdk';
import type { NuvioConfig } from '../config.js';
import { resolvePublicMeta } from '../stremio/meta.js';
import { serially } from '../serially.js';
import { rpc } from './api.js';
import { accessToken } from './sessions.js';

const logger = createLogger('nuvio-push');

/** Positions under this are a start that never got going. */
const MIN_RESUME_MS = 1000;

/** One call to Nuvio's sync API: the function and its arguments. */
export interface NuvioCall {
  name: string;
  args: Record<string, unknown>;
}

/** An episode; `season` is null for absolute numbering (anime), which Nuvio stores as such. */
type Episode = { season: number | null; episode: number };

const isEpisode = (
  value: { season?: number | null; episode?: number | null } | undefined
): value is Episode =>
  !!value &&
  typeof value.episode === 'number' &&
  (typeof value.season === 'number' || value.season == null);

const toEpisode = (v: {
  season?: number | null;
  episode: number;
}): Episode => ({
  season: v.season ?? null,
  episode: v.episode,
});

/**
 * Nuvio's key for a resume point, as its apps and its server build it: an
 * episode without a season shares the title's key there too.
 */
export function progressKey(contentId: string, at?: Episode): string {
  return at && at.season !== null
    ? `${contentId}_s${at.season}e${at.episode}`
    : contentId;
}

/** Nuvio's key for one watched mark: the season is left out when there is none. */
const watchedKey = (content_id: string, at: Episode) =>
  at.season === null
    ? { content_id, episode: at.episode }
    : { content_id, season: at.season, episode: at.episode };

/** Durations seen per resume point, for events that do not carry one: Nuvio would store 0. */
const DURATIONS_KEPT = 5000;
const durationsSeen = new Map<string, number>();

function contentTypeOf(event: WatchStateEvent): 'movie' | 'series' {
  return event.scope === 'movie' ? 'movie' : 'series';
}

function stampOf(event: WatchStateEvent, nowMs: number): number {
  const at = Number(event.at) * 1000;
  return Number.isFinite(at) && at > 0 ? Math.min(at, nowMs) : nowMs;
}

/**
 * The Nuvio sync calls one AIOStreams event becomes, in order. Watched marks
 * also drop the matching resume point, as Nuvio does when an episode ends.
 */
export function nuvioCalls(
  event: WatchStateEvent,
  profile: number,
  nowMs: number,
  meta?: { name: string; poster: string | null },
  durations: Map<string, number> = new Map()
): NuvioCall[] {
  const p_profile_id = profile;
  const content_id = event.metaId;
  const content_type = contentTypeOf(event);
  const when = stampOf(event, nowMs);
  const finished =
    event.event === 'played' ||
    (event.event === 'stop' && event.played === true);
  // Nuvio overwrites a title on every write, so never send an empty one.
  const title = meta?.name || content_id;

  if (event.event === 'watchlisted') {
    return [
      {
        name: 'sync_push_library_items',
        args: {
          p_profile_id,
          p_items: [
            {
              content_id,
              content_type,
              name: title,
              poster: meta?.poster ?? null,
              poster_shape: 'POSTER',
              added_at: when,
            },
          ],
        },
      },
    ];
  }
  if (event.event === 'unwatchlisted') {
    return [
      {
        name: 'sync_delete_library_items',
        args: { p_profile_id, p_keys: [{ content_id, content_type }] },
      },
    ];
  }

  if (event.scope === 'season' || event.scope === 'series') {
    if (event.event !== 'played' && event.event !== 'unplayed') return [];
    const episodes: Episode[] = event.videos.flatMap((v) =>
      isEpisode(v) ? [toEpisode(v)] : []
    );
    if (!episodes.length) return [];
    if (event.event === 'unplayed') {
      return [
        {
          name: 'sync_delete_watched_items',
          args: {
            p_profile_id,
            p_keys: episodes.map((v) => watchedKey(content_id, v)),
          },
        },
      ];
    }
    return [
      {
        name: 'sync_push_watched_items',
        args: {
          p_profile_id,
          p_items: episodes.map((v) => ({
            content_id,
            content_type,
            title,
            season: v.season,
            episode: v.episode,
            watched_at: when,
          })),
        },
      },
      {
        name: 'sync_delete_watch_progress',
        args: {
          p_profile_id,
          p_keys: episodes.map((v) => progressKey(content_id, v)),
        },
      },
    ];
  }

  if (!('videoId' in event)) return [];
  const episode = isEpisode(event) ? toEpisode(event) : undefined;
  if (event.scope === 'episode' && !episode) return [];
  const key = progressKey(content_id, episode);
  const at = episode
    ? { season: episode.season, episode: episode.episode }
    : { season: null, episode: null };

  if (event.event === 'unplayed') {
    return [
      {
        name: 'sync_delete_watched_items',
        args: {
          p_profile_id,
          p_keys: [episode ? watchedKey(content_id, episode) : { content_id }],
        },
      },
    ];
  }
  if (finished) {
    return [
      {
        name: 'sync_push_watched_items',
        args: {
          p_profile_id,
          p_items: [
            { content_id, content_type, title, ...at, watched_at: when },
          ],
        },
      },
      {
        name: 'sync_delete_watch_progress',
        args: { p_profile_id, p_keys: [key] },
      },
    ];
  }
  if (
    (event.event === 'start' ||
      event.event === 'pause' ||
      event.event === 'stop') &&
    event.positionMs >= MIN_RESUME_MS
  ) {
    const known = event.durationMs && event.durationMs > 0;
    if (known) durations.set(key, Math.round(event.durationMs!));
    const duration = known
      ? Math.round(event.durationMs!)
      : (durations.get(key) ?? 0);
    return [
      {
        name: 'sync_push_watch_progress',
        args: {
          p_profile_id,
          p_entries: [
            {
              content_id,
              content_type,
              video_id: episode ? event.videoId : content_id,
              ...at,
              position: Math.round(event.positionMs),
              duration,
              last_watched: when,
              progress_key: key,
            },
          ],
        },
      },
    ];
  }
  return [];
}

/** Writes an AIOStreams event into the Nuvio profile. */
/** Writes that carry a title: library items, and watched marks (Nuvio overwrites their title). */
const named = (event: WatchStateEvent) =>
  event.event === 'watchlisted' ||
  event.event === 'played' ||
  (event.event === 'stop' && event.played === true);

/** Writes an AIOStreams event into the Nuvio profile, one at a time per title. */
export function pushToNuvio(
  config: NuvioConfig,
  event: WatchStateEvent,
  nowMs: () => number = Date.now
): Promise<void> {
  const key = `nuvio\0${config.session}\0${config.profile}\0${event.metaId}`;
  return serially(key, async () => {
    const meta = named(event)
      ? await resolvePublicMeta(contentTypeOf(event), event.metaId).then(
          (found) =>
            found
              ? { name: found.name ?? '', poster: found.poster ?? null }
              : undefined
        )
      : undefined;
    if (durationsSeen.size > DURATIONS_KEPT) durationsSeen.clear();
    const calls = nuvioCalls(
      event,
      config.profile,
      nowMs(),
      meta,
      durationsSeen
    );
    if (!calls.length) return;
    const access = await accessToken(config.session, config.key);
    for (const call of calls) await rpc(access, call.name, call.args);
    logger.debug({ id: event.metaId, event: event.event }, 'written to Nuvio');
  });
}
