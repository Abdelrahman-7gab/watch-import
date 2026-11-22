import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { WatchStateEvent } from '@aiostreams/addon-sdk';
import { nuvioCalls, progressKey } from './push.js';

const NOW = Date.UTC(2026, 10, 22, 20, 0, 0);
const AT = Math.floor(Date.UTC(2026, 10, 22, 19, 30, 0) / 1000);
const base = { id: 'e', at: AT, ids: {} };
const PROFILE = 2;

const episode = (event: string, extra: Record<string, unknown> = {}) =>
  ({
    ...base,
    event,
    scope: 'episode',
    metaId: 'tt0903747',
    videoId: 'tt0903747:3:7',
    season: 3,
    episode: 7,
    ...extra,
  }) as WatchStateEvent;
const film = (event: string, extra: Record<string, unknown> = {}) =>
  ({
    ...base,
    event,
    scope: 'movie',
    metaId: 'tt0816692',
    videoId: 'tt0816692',
    ...extra,
  }) as WatchStateEvent;

describe('progressKey', () => {
  it("is Nuvio's own key: the title, or title_sNeN for an episode", () => {
    assert.equal(progressKey('tt0816692'), 'tt0816692');
    assert.equal(
      progressKey('tt0903747', { season: 3, episode: 7 }),
      'tt0903747_s3e7'
    );
  });
});

describe('nuvioCalls', () => {
  it("writes a pause as the profile's resume point", () => {
    const calls = nuvioCalls(
      episode('pause', { positionMs: 600_400.6, durationMs: 2_820_000 }),
      PROFILE,
      NOW
    );
    assert.deepEqual(calls, [
      {
        name: 'sync_push_watch_progress',
        args: {
          p_profile_id: PROFILE,
          p_entries: [
            {
              content_id: 'tt0903747',
              content_type: 'series',
              video_id: 'tt0903747:3:7',
              season: 3,
              episode: 7,
              position: 600_401,
              duration: 2_820_000,
              last_watched: AT * 1000,
              progress_key: 'tt0903747_s3e7',
            },
          ],
        },
      },
    ]);
  });

  it("keys a film's resume point on the film, with no season", () => {
    const [call] = nuvioCalls(
      film('stop', { positionMs: 5000, played: false }),
      PROFILE,
      NOW
    );
    const entry = (call.args.p_entries as Record<string, unknown>[])[0];
    assert.equal(entry.progress_key, 'tt0816692');
    assert.equal(entry.video_id, 'tt0816692');
    assert.equal(entry.content_type, 'movie');
    assert.equal(entry.season, null);
    assert.equal(entry.duration, 0);
  });

  it('marks a finished episode watched and drops its resume point', () => {
    const calls = nuvioCalls(
      episode('stop', { positionMs: 2_800_000, played: true }),
      PROFILE,
      NOW
    );
    assert.deepEqual(
      calls.map((c) => c.name),
      ['sync_push_watched_items', 'sync_delete_watch_progress']
    );
    assert.deepEqual(calls[0].args.p_items, [
      {
        content_id: 'tt0903747',
        content_type: 'series',
        title: '',
        season: 3,
        episode: 7,
        watched_at: AT * 1000,
      },
    ]);
    assert.deepEqual(calls[1].args.p_keys, ['tt0903747_s3e7']);
  });

  it('clears a watched mark by its key', () => {
    assert.deepEqual(nuvioCalls(film('unplayed'), PROFILE, NOW), [
      {
        name: 'sync_delete_watched_items',
        args: { p_profile_id: PROFILE, p_keys: [{ content_id: 'tt0816692' }] },
      },
    ]);
    const [call] = nuvioCalls(episode('unplayed'), PROFILE, NOW);
    assert.deepEqual(call.args.p_keys, [
      { content_id: 'tt0903747', season: 3, episode: 7 },
    ]);
  });

  it('marks a whole season in one call', () => {
    const bulk = {
      ...base,
      event: 'played',
      scope: 'season',
      metaId: 'tt0903747',
      season: 1,
      videos: [
        { videoId: 'tt0903747:1:1', season: 1, episode: 1 },
        { videoId: 'tt0903747:1:2', season: 1, episode: 2 },
        { videoId: 'special' },
      ],
      part: 1,
      parts: 1,
    } as WatchStateEvent;
    const [watched, progress] = nuvioCalls(bulk, PROFILE, NOW);
    assert.equal((watched.args.p_items as unknown[]).length, 2);
    assert.deepEqual(progress.args.p_keys, [
      'tt0903747_s1e1',
      'tt0903747_s1e2',
    ]);
  });

  it('adds and removes library items with their name and poster', () => {
    const [add] = nuvioCalls(film('watchlisted'), PROFILE, NOW, {
      name: 'Interstellar',
      poster: 'p.jpg',
    });
    assert.equal(add.name, 'sync_push_library_items');
    assert.deepEqual(add.args.p_items, [
      {
        content_id: 'tt0816692',
        content_type: 'movie',
        name: 'Interstellar',
        poster: 'p.jpg',
        poster_shape: 'POSTER',
        added_at: AT * 1000,
      },
    ]);
    assert.deepEqual(nuvioCalls(film('unwatchlisted'), PROFILE, NOW), [
      {
        name: 'sync_delete_library_items',
        args: {
          p_profile_id: PROFILE,
          p_keys: [{ content_id: 'tt0816692', content_type: 'movie' }],
        },
      },
    ]);
  });

  it('sends nothing for a start that never got going, or for drops', () => {
    assert.deepEqual(
      nuvioCalls(film('start', { positionMs: 0 }), PROFILE, NOW),
      []
    );
    assert.deepEqual(nuvioCalls(film('dropped'), PROFILE, NOW), []);
  });
});
