import { createLogger, type WatchStateEvent } from '@aiostreams/addon-sdk';
import { accountKey, type NuvioConfig } from '../config.js';
import { isFinished, stampOf } from '../events.js';
import { resolvePublicMeta, type Meta } from '../stremio/meta.js';
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

type Numbered = {
  videoId?: string;
  season?: number | null;
  episode?: number | null;
};

const isEpisode = (value: Numbered): value is Episode =>
  typeof value.episode === 'number' &&
  (typeof value.season === 'number' || value.season == null);

const WHOLE = /^\d+$/;

/**
 * The video's episode: from its numbers, else from its id when that is
 * `<metaId>:<season>:<episode>` or `<metaId>:<episode>`. A video id from
 * another id space is not read, since its numbering may not be the title's.
 */
function episodeOf(metaId: string, video: Numbered): Episode | undefined {
  if (isEpisode(video))
    return { season: video.season ?? null, episode: video.episode };
  const prefix = `${metaId}:`;
  if (!video.videoId?.startsWith(prefix)) return undefined;
  const parts = video.videoId.slice(prefix.length).split(':');
  if (!parts.every((part) => WHOLE.test(part))) return undefined;
  const [first, second] = parts.map(Number);
  if (parts.length === 2) return { season: first, episode: second };
  if (parts.length === 1) return { season: null, episode: first };
  return undefined;
}

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

/** A map that forgets its oldest entries past `limit`. Setting a key again makes it the newest. */
export class Recent<V> {
  private readonly entries = new Map<string, V>();

  constructor(private readonly limit: number) {}

  get size(): number {
    return this.entries.size;
  }

  get(key: string): V | undefined {
    return this.entries.get(key);
  }

  set(key: string, value: V): void {
    this.entries.delete(key);
    this.entries.set(key, value);
    if (this.entries.size > this.limit)
      this.entries.delete(this.entries.keys().next().value!);
  }
}

/** What the writer remembers between events, for one Nuvio session and profile. */
export interface Recall {
  /** Starts every key, so one session's or profile's entries never answer another's. */
  scope: string;
  /** Stream lengths by video, for events that carry none: Nuvio would store 0. */
  durations: Recent<number>;
  /** When a finish last dropped each resume point, so a late or retried progress write cannot bring it back. */
  finished: Recent<number>;
}

const KEPT = 5000;
const durationsSeen = new Recent<number>(KEPT);
const finishedAt = new Recent<number>(KEPT);

/** The writer's memory for this link's session and profile. */
export function recallFor(config: NuvioConfig): Recall {
  return {
    scope: `${accountKey(config.session)}\0${config.profile}`,
    durations: durationsSeen,
    finished: finishedAt,
  };
}

const forgetful = (): Recall => ({
  scope: '',
  durations: new Recent(KEPT),
  finished: new Recent(KEPT),
});

function contentTypeOf(event: WatchStateEvent): 'movie' | 'series' {
  return event.scope === 'movie' ? 'movie' : 'series';
}

/**
 * The Nuvio sync calls one AIOStreams event becomes, in order. Watched marks
 * also drop the matching resume point, as Nuvio does when an episode ends.
 * The same event with the same `recall` always gives the same calls.
 */
export function nuvioCalls(
  event: WatchStateEvent,
  profile: number,
  nowMs: number,
  meta?: { name: string; poster: string | null },
  recall: Recall = forgetful()
): NuvioCall[] {
  const p_profile_id = profile;
  const content_id = event.metaId;
  const content_type = contentTypeOf(event);
  const when = stampOf(event, nowMs);
  // Nuvio overwrites a title on every write, so never send an empty one.
  const title = meta?.name || content_id;
  const finishedKey = (key: string) => `${recall.scope}\0${key}`;

  /** Drops resume points, and remembers when, for the stale check below. */
  const dropProgress = (keys: string[]): NuvioCall => {
    for (const key of keys) {
      const known = recall.finished.get(finishedKey(key)) ?? 0;
      recall.finished.set(finishedKey(key), Math.max(known, when));
    }
    return {
      name: 'sync_delete_watch_progress',
      args: { p_profile_id, p_keys: keys },
    };
  };

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
    const episodes: Episode[] = event.videos.flatMap((v) => {
      const at = episodeOf(content_id, v);
      return at ? [at] : [];
    });
    if (episodes.length < event.videos.length)
      logger.debug(
        { id: content_id, skipped: event.videos.length - episodes.length },
        'videos without an episode number in a bulk mark; skipped'
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
    // Absolute-numbered episodes share the title's resume point: a bulk mark
    // cannot tell whether it belongs to one of the marked episodes, so leave it.
    const progressKeys = [
      ...new Set(
        episodes
          .filter((v) => v.season !== null)
          .map((v) => progressKey(content_id, v))
      ),
    ];
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
      ...(progressKeys.length ? [dropProgress(progressKeys)] : []),
    ];
  }

  if (!('videoId' in event)) return [];
  const episode =
    event.scope === 'episode'
      ? episodeOf(content_id, event)
      : isEpisode(event)
        ? { season: event.season ?? null, episode: event.episode }
        : undefined;
  if (event.scope === 'episode' && !episode) {
    logger.debug(
      { id: content_id, videoId: event.videoId, event: event.event },
      'no episode number in the event or its video id; skipped'
    );
    return [];
  }
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
  if (isFinished(event)) {
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
      dropProgress([key]),
    ];
  }
  if (
    (event.event === 'start' ||
      event.event === 'pause' ||
      event.event === 'stop') &&
    event.positionMs >= MIN_RESUME_MS
  ) {
    // A late or retried event never brings back a resume point a newer finish dropped.
    const done = recall.finished.get(finishedKey(key));
    if (done !== undefined && when <= done) {
      logger.debug(
        { id: content_id, event: event.event },
        'progress from before the finish; skipped'
      );
      return [];
    }
    const durationKey = `${recall.scope}\0${event.videoId}`;
    const known = event.durationMs && event.durationMs > 0;
    if (known) recall.durations.set(durationKey, Math.round(event.durationMs!));
    const duration = known
      ? Math.round(event.durationMs!)
      : (recall.durations.get(durationKey) ?? 0);
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

/** Writes that carry a title: library items, and watched marks (Nuvio overwrites their title). */
const named = (event: WatchStateEvent) =>
  event.event === 'watchlisted' || isFinished(event);

/** What a push reaches outside this module; tests pass their own. */
export interface NuvioIo {
  lookup: (type: string, id: string, account: string) => Promise<Meta | null>;
  token: (session: string, key: string) => Promise<string>;
  rpc: (accessToken: string, name: string, args: object) => Promise<unknown>;
}

const live: NuvioIo = { lookup: resolvePublicMeta, token: accessToken, rpc };

/**
 * The title's name and poster from the public meta addons, trying `anime`
 * after `series` as the Stremio writer does. Throws when they cannot be asked
 * now, so the push fails and is retried rather than naming the title by its id.
 */
async function titleOf(
  event: WatchStateEvent,
  lookup: NuvioIo['lookup'],
  account: string
): Promise<{ name: string; poster: string | null } | undefined> {
  const types = event.scope === 'movie' ? ['movie'] : ['series', 'anime'];
  for (const type of types) {
    const found = await lookup(type, event.metaId, account);
    if (found) return { name: found.name ?? '', poster: found.poster ?? null };
  }
  return undefined;
}

/** Writes an AIOStreams event into the Nuvio profile, one at a time per title. */
export function pushToNuvio(
  config: NuvioConfig,
  event: WatchStateEvent,
  nowMs: () => number = Date.now,
  io: NuvioIo = live
): Promise<void> {
  const key = `nuvio\0${config.session}\0${config.profile}\0${event.metaId}`;
  return serially(key, async () => {
    const recall = recallFor(config);
    const now = nowMs();
    // Built without a title first, so the title is only looked up when something will be written.
    let calls = nuvioCalls(event, config.profile, now, undefined, recall);
    if (!calls.length) return;
    if (named(event)) {
      const meta = await titleOf(event, io.lookup, accountKey(config.session));
      if (meta) calls = nuvioCalls(event, config.profile, now, meta, recall);
    }
    const access = await io.token(config.session, config.key);
    for (const call of calls) await io.rpc(access, call.name, call.args);
    logger.debug({ id: event.metaId, event: event.event }, 'written to Nuvio');
  });
}
