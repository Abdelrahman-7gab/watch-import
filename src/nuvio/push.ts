import { createLogger, type WatchStateEvent } from '@aiostreams/addon-sdk';
import type { NuvioConfig } from '../config.js';
import { resolvePublicMeta } from '../stremio/meta.js';
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

type Episode = { season: number; episode: number };

const isEpisode = (
  value: { season?: number | null; episode?: number | null } | undefined
): value is Episode =>
  !!value &&
  typeof value.season === 'number' &&
  typeof value.episode === 'number';

/** Nuvio's key for a resume point, as its apps and its server build it. */
export function progressKey(contentId: string, at?: Episode): string {
  return at ? `${contentId}_s${at.season}e${at.episode}` : contentId;
}

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
  library?: { name: string; poster: string | null }
): NuvioCall[] {
  const p_profile_id = profile;
  const content_id = event.metaId;
  const content_type = contentTypeOf(event);
  const when = stampOf(event, nowMs);
  const finished =
    event.event === 'played' ||
    (event.event === 'stop' && event.played === true);

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
              name: library?.name ?? '',
              poster: library?.poster ?? null,
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
      isEpisode(v) ? [{ season: v.season, episode: v.episode }] : []
    );
    if (!episodes.length) return [];
    if (event.event === 'unplayed') {
      return [
        {
          name: 'sync_delete_watched_items',
          args: {
            p_profile_id,
            p_keys: episodes.map((v) => ({
              content_id,
              season: v.season,
              episode: v.episode,
            })),
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
            title: '',
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
  const episode = isEpisode(event) ? event : undefined;
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
          p_keys: [episode ? { content_id, ...at } : { content_id }],
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
            { content_id, content_type, title: '', ...at, watched_at: when },
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
              duration: Math.round(event.durationMs ?? 0),
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
export async function pushToNuvio(
  config: NuvioConfig,
  event: WatchStateEvent,
  nowMs: () => number = Date.now
): Promise<void> {
  const library =
    event.event === 'watchlisted'
      ? await resolvePublicMeta(contentTypeOf(event), event.metaId).then(
          (meta) => ({ name: meta?.name ?? '', poster: meta?.poster ?? null })
        )
      : undefined;
  const calls = nuvioCalls(event, config.profile, nowMs(), library);
  if (!calls.length) return;
  const access = await accessToken(config.session, config.key);
  for (const call of calls) await rpc(access, call.name, call.args);
  logger.debug({ id: event.metaId, event: event.event }, 'written to Nuvio');
}
