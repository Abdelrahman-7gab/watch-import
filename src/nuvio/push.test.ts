import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { WatchStateEvent } from '@aiostreams/addon-sdk';
import type { NuvioConfig } from '../config.js';
import { accountKey } from '../config.js';
import { UpstreamError } from '../http.js';
import {
  nuvioCalls,
  progressKey,
  pushToNuvio,
  recallFor,
  Recent,
} from './push.js';

const NOW = Date.UTC(2026, 10, 22, 20, 0, 0);
const AT = Math.floor(Date.UTC(2026, 10, 22, 19, 30, 0) / 1000);
const base = { id: 'e', at: AT, ids: {} };
const PROFILE = 2;

const nuvio = (session: string, profile = PROFILE): NuvioConfig => ({
  service: 'nuvio',
  session,
  key: 'k',
  profile,
  library: true,
  writeBack: true,
});

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
        // No meta here: the id, since Nuvio overwrites a stored title with whatever is sent.
        title: 'tt0903747',
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

describe('nuvioCalls: what the reviews found', () => {
  const absolute = (event: string, extra: Record<string, unknown> = {}) =>
    episode(event, {
      metaId: 'kitsu:1376',
      videoId: 'kitsu:1376:12',
      season: null,
      episode: 12,
      ...extra,
    });

  it('writes episodes with absolute numbering, keyed as Nuvio keys them', () => {
    const played = nuvioCalls(absolute('played'), PROFILE, NOW);
    assert.deepEqual(played[0].args.p_items, [
      {
        content_id: 'kitsu:1376',
        content_type: 'series',
        title: 'kitsu:1376',
        season: null,
        episode: 12,
        watched_at: AT * 1000,
      },
    ]);
    assert.deepEqual(played[1].args.p_keys, ['kitsu:1376']);
    const cleared = nuvioCalls(absolute('unplayed'), PROFILE, NOW);
    assert.deepEqual(cleared[0].args.p_keys, [
      { content_id: 'kitsu:1376', episode: 12 },
    ]);
    const paused = nuvioCalls(
      absolute('pause', { positionMs: 60_000, durationMs: 1_440_000 }),
      PROFILE,
      NOW
    );
    const entry = (paused[0].args.p_entries as Record<string, unknown>[])[0];
    assert.equal(entry.season, null);
    assert.equal(entry.episode, 12);
    assert.equal(entry.progress_key, 'kitsu:1376');
  });

  it('keeps absolute-numbered episodes in a bulk mark', () => {
    const bulk = {
      ...base,
      event: 'played',
      scope: 'series',
      metaId: 'kitsu:1376',
      videos: [
        { videoId: 'kitsu:1376:1', season: null, episode: 1 },
        { videoId: 'kitsu:1376:2', season: null, episode: 2 },
      ],
      part: 1,
      parts: 1,
    } as WatchStateEvent;
    const [push] = nuvioCalls(bulk, PROFILE, NOW);
    assert.equal((push.args.p_items as unknown[]).length, 2);
  });

  it('reuses the last known duration when an event does not carry one', () => {
    const recall = recallFor(nuvio('known-duration'));
    nuvioCalls(
      episode('start', { positionMs: 5_000, durationMs: 2_820_000 }),
      PROFILE,
      NOW,
      undefined,
      recall
    );
    const [pause] = nuvioCalls(
      episode('pause', { positionMs: 600_000 }),
      PROFILE,
      NOW,
      undefined,
      recall
    );
    const entry = (pause.args.p_entries as Record<string, unknown>[])[0];
    assert.equal(entry.duration, 2_820_000);
  });

  it('names what it writes, so a re-mark never blanks the title', () => {
    const meta = { name: 'Breaking Bad', poster: 'p.jpg' };
    const [push] = nuvioCalls(episode('played'), PROFILE, NOW, meta);
    assert.equal(
      (push.args.p_items as Record<string, unknown>[])[0].title,
      'Breaking Bad'
    );
    const [item] = nuvioCalls(film('watchlisted'), PROFILE, NOW);
    assert.equal(
      (item.args.p_items as Record<string, unknown>[])[0].name,
      'tt0816692',
      'falls back to the id, as the Stremio writer does'
    );
  });
});

const entryOf = (call: { args: Record<string, unknown> }) =>
  (call.args.p_entries as Record<string, unknown>[])[0];
const itemOf = (call: { args: Record<string, unknown> }) =>
  (call.args.p_items as Record<string, unknown>[])[0];

describe('nuvioCalls: a late progress write after a finish', () => {
  it('never brings back the resume point a finish dropped', () => {
    const recall = recallFor(nuvio('late-pause'));
    nuvioCalls(episode('played'), PROFILE, NOW, undefined, recall);
    const late = episode('pause', { positionMs: 600_000, at: AT - 30 });
    assert.deepEqual(nuvioCalls(late, PROFILE, NOW, undefined, recall), []);
    const retried = episode('pause', { positionMs: 600_000 });
    assert.deepEqual(
      nuvioCalls(retried, PROFILE, NOW, undefined, recall),
      [],
      'same stamp as the finish'
    );
    const rewatch = episode('start', { positionMs: 5_000, at: AT + 60 });
    const [call] = nuvioCalls(rewatch, PROFILE, NOW, undefined, recall);
    assert.equal(call?.name, 'sync_push_watch_progress', 'a newer play counts');
  });

  it('remembers a finished stop and a season mark too', () => {
    const recall = recallFor(nuvio('late-stop'));
    nuvioCalls(
      episode('stop', { positionMs: 2_800_000, played: true }),
      PROFILE,
      NOW,
      undefined,
      recall
    );
    const late = episode('pause', { positionMs: 600_000, at: AT - 30 });
    assert.deepEqual(nuvioCalls(late, PROFILE, NOW, undefined, recall), []);

    const season = {
      ...base,
      event: 'played',
      scope: 'season',
      metaId: 'tt0903747',
      season: 1,
      videos: [{ videoId: 'tt0903747:1:1', season: 1, episode: 1 }],
      part: 1,
      parts: 1,
    } as WatchStateEvent;
    nuvioCalls(season, PROFILE, NOW, undefined, recall);
    const lateS1 = episode('pause', {
      videoId: 'tt0903747:1:1',
      season: 1,
      episode: 1,
      positionMs: 600_000,
      at: AT - 30,
    });
    assert.deepEqual(nuvioCalls(lateS1, PROFILE, NOW, undefined, recall), []);
  });

  it('keeps each session and profile apart', () => {
    nuvioCalls(
      episode('played'),
      PROFILE,
      NOW,
      undefined,
      recallFor(nuvio('apart'))
    );
    const late = episode('pause', { positionMs: 600_000, at: AT - 30 });
    for (const other of [nuvio('apart', 3), nuvio('apart-too')]) {
      const calls = nuvioCalls(
        late,
        other.profile,
        NOW,
        undefined,
        recallFor(other)
      );
      assert.equal(calls.length, 1);
    }
  });
});

describe('Recent', () => {
  it('forgets the oldest entries first past its limit', () => {
    const recent = new Recent<number>(2);
    recent.set('a', 1);
    recent.set('b', 2);
    recent.set('c', 3);
    assert.equal(recent.get('a'), undefined);
    assert.equal(recent.get('b'), 2);
    assert.equal(recent.get('c'), 3);
    assert.equal(recent.size, 2);
  });
});

describe('nuvioCalls: bulk marks of absolute-numbered episodes', () => {
  const bulk = (videos: Record<string, unknown>[], metaId = 'kitsu:1376') =>
    ({
      ...base,
      event: 'played',
      scope: 'series',
      metaId,
      videos,
      part: 1,
      parts: 1,
    }) as WatchStateEvent;

  it("never drops the title's shared resume point", () => {
    const calls = nuvioCalls(
      bulk([
        { videoId: 'kitsu:1376:1', season: null, episode: 1 },
        { videoId: 'kitsu:1376:2', season: null, episode: 2 },
      ]),
      PROFILE,
      NOW
    );
    assert.deepEqual(
      calls.map((c) => c.name),
      ['sync_push_watched_items']
    );
  });

  it('leaves a later episode resumable after a bulk mark', () => {
    const recall = recallFor(nuvio('bulk-absolute'));
    nuvioCalls(
      bulk([{ videoId: 'kitsu:1376:1', season: null, episode: 1 }]),
      PROFILE,
      NOW,
      undefined,
      recall
    );
    const paused = episode('pause', {
      metaId: 'kitsu:1376',
      videoId: 'kitsu:1376:11',
      season: null,
      episode: 11,
      positionMs: 720_000,
      at: AT - 30,
    });
    assert.equal(nuvioCalls(paused, PROFILE, NOW, undefined, recall).length, 1);
  });

  it('sends each resume point key once', () => {
    const [, progress] = nuvioCalls(
      bulk(
        [
          { videoId: 'tt0903747:1:1', season: 1, episode: 1 },
          { videoId: 'tt0903747:1:1b', season: 1, episode: 1 },
          { videoId: 'tt0903747:1:2', season: 1, episode: 2 },
          { videoId: 'tt0903747:5', season: null, episode: 5 },
        ],
        'tt0903747'
      ),
      PROFILE,
      NOW
    );
    assert.deepEqual(progress.args.p_keys, [
      'tt0903747_s1e1',
      'tt0903747_s1e2',
    ]);
  });
});

describe('nuvioCalls: episode numbers from the video id', () => {
  it('reads season and episode from <id>:<season>:<episode>', () => {
    const calls = nuvioCalls(
      episode('played', { season: undefined, episode: undefined }),
      PROFILE,
      NOW
    );
    assert.equal(itemOf(calls[0]).season, 3);
    assert.equal(itemOf(calls[0]).episode, 7);
    assert.deepEqual(calls[1].args.p_keys, ['tt0903747_s3e7']);
  });

  it('reads an absolute episode from <id>:<episode>', () => {
    const [call] = nuvioCalls(
      episode('pause', {
        metaId: 'kitsu:1376',
        videoId: 'kitsu:1376:12',
        season: undefined,
        episode: undefined,
        positionMs: 60_000,
      }),
      PROFILE,
      NOW
    );
    assert.equal(entryOf(call).season, null);
    assert.equal(entryOf(call).episode, 12);
  });

  it('fills in a season mark whose videos carry no numbers', () => {
    const season = {
      ...base,
      event: 'played',
      scope: 'season',
      metaId: 'tt0903747',
      season: 1,
      videos: [{ videoId: 'tt0903747:1:3' }, { videoId: 'special' }],
      part: 1,
      parts: 1,
    } as WatchStateEvent;
    const [watched] = nuvioCalls(season, PROFILE, NOW);
    assert.deepEqual(
      (watched.args.p_items as Record<string, unknown>[]).map((i) => [
        i.season,
        i.episode,
      ]),
      [[1, 3]]
    );
  });

  it('writes nothing for a video id it cannot read', () => {
    for (const videoId of ['kitsu:99:4', 'tt0903747', 'tt0903747:x:y']) {
      assert.deepEqual(
        nuvioCalls(
          episode('played', { videoId, season: undefined, episode: undefined }),
          PROFILE,
          NOW
        ),
        [],
        videoId
      );
    }
  });
});

describe('nuvioCalls: durations', () => {
  it('never lends one session, profile or episode its duration', () => {
    const known = recallFor(nuvio('durations'));
    nuvioCalls(
      episode('start', { positionMs: 5_000, durationMs: 2_820_000 }),
      PROFILE,
      NOW,
      undefined,
      known
    );
    const pause = episode('pause', { positionMs: 600_000 });
    for (const other of [nuvio('durations', 3), nuvio('durations-too')]) {
      const [call] = nuvioCalls(
        pause,
        other.profile,
        NOW,
        undefined,
        recallFor(other)
      );
      assert.equal(entryOf(call).duration, 0);
    }
    const [same] = nuvioCalls(pause, PROFILE, NOW, undefined, known);
    assert.equal(entryOf(same).duration, 2_820_000);

    const absolute = (n: number, extra: Record<string, unknown> = {}) =>
      episode('pause', {
        metaId: 'kitsu:1376',
        videoId: `kitsu:1376:${n}`,
        season: null,
        episode: n,
        positionMs: 60_000,
        ...extra,
      });
    nuvioCalls(
      absolute(1, { durationMs: 1_440_000 }),
      PROFILE,
      NOW,
      undefined,
      known
    );
    const [next] = nuvioCalls(absolute(2), PROFILE, NOW, undefined, known);
    assert.equal(entryOf(next).duration, 0, 'episode 2 is not episode 1');
  });
});

describe('pushToNuvio', () => {
  type Lookup = [type: string, id: string, account: string];

  /** Runs a push against fakes, recording what was looked up and sent. */
  async function pushed(
    config: NuvioConfig,
    event: WatchStateEvent,
    lookup: (
      type: string,
      id: string
    ) => Promise<{ name?: string; poster?: string } | null> = async () => null
  ) {
    const lookups: Lookup[] = [];
    const sent: { name: string; args: Record<string, unknown> }[] = [];
    let tokens = 0;
    await pushToNuvio(config, event, () => NOW, {
      lookup: async (type, id, account) => {
        lookups.push([type, id, account]);
        const found = await lookup(type, id);
        return found ? { id, videos: [], ...found } : null;
      },
      token: async () => {
        tokens++;
        return 'access';
      },
      rpc: async (_access, name, args) => {
        sent.push({ name, args: args as Record<string, unknown> });
        return null;
      },
    });
    return { lookups, sent, tokens };
  }

  it('names an anime from its anime meta when the series lookup has none', async () => {
    const config = nuvio('anime-title');
    const { lookups, sent } = await pushed(
      config,
      episode('played', {
        metaId: 'kitsu:1376',
        videoId: 'kitsu:1376:12',
        season: null,
        episode: 12,
      }),
      async (type) => (type === 'anime' ? { name: 'Steins;Gate' } : null)
    );
    const account = accountKey(config.session);
    assert.deepEqual(lookups, [
      ['series', 'kitsu:1376', account],
      ['anime', 'kitsu:1376', account],
    ]);
    assert.equal(itemOf(sent[0]).title, 'Steins;Gate');
  });

  it('queues lookups by the account, never by the raw session', async () => {
    const config = nuvio('raw-session-id');
    const { lookups } = await pushed(config, film('watchlisted'), async () => ({
      name: 'Interstellar',
    }));
    assert.equal(lookups.length, 1);
    assert.equal(lookups[0][2], accountKey('raw-session-id'));
    assert.notEqual(lookups[0][2], 'raw-session-id');
  });

  it('looks nothing up when nothing will be written', async () => {
    const season = {
      ...base,
      event: 'played',
      scope: 'season',
      metaId: 'tt0903747',
      season: 1,
      videos: [{ videoId: 'special' }],
      part: 1,
      parts: 1,
    } as WatchStateEvent;
    const { lookups, sent, tokens } = await pushed(nuvio('nothing'), season);
    assert.deepEqual(lookups, []);
    assert.deepEqual(sent, []);
    assert.equal(tokens, 0);
  });

  it('fails, so AIOStreams retries, when the title cannot be looked up now', async () => {
    const sent: string[] = [];
    await assert.rejects(
      pushToNuvio(nuvio('lookup-down'), episode('played'), () => NOW, {
        lookup: async () => {
          throw new UpstreamError('v3-cinemeta.strem.io: HTTP 503');
        },
        token: async () => 'access',
        rpc: async (_access, name) => {
          sent.push(name);
          return null;
        },
      }),
      UpstreamError
    );
    assert.deepEqual(sent, [], 'no title-less write');
  });
});
