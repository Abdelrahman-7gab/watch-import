import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { WatchStateEvent } from '@aiostreams/addon-sdk';
import { manifestFor } from '../manifest.js';
import { applyEvent, newItem } from './push.js';
import type { Meta } from './meta.js';
import { WatchedBitField } from './watched.js';
import { isInContinueWatching } from './library-item.js';

const NOW = Date.UTC(2026, 10, 22, 20, 0, 0);
const AT = Math.floor(Date.UTC(2026, 10, 22, 19, 30, 0) / 1000);

const film: Meta = {
  id: 'tt0816692',
  videos: [],
  name: 'Interstellar',
  poster: 'p.jpg',
};
const show: Meta = {
  id: 'tt0903747',
  name: 'Breaking Bad',
  videos: [
    { id: 'tt0903747:1:2', season: 1, episode: 2, released: null },
    { id: 'tt0903747:1:1', season: 1, episode: 1, released: null },
    { id: 'tt0903747:2:1', season: 2, episode: 1, released: null },
  ],
};
const order = ['tt0903747:1:1', 'tt0903747:1:2', 'tt0903747:2:1'];

const base = { id: 'e', at: AT, ids: {} };
const playback = (
  event: 'start' | 'pause' | 'stop',
  scope: 'movie' | 'episode',
  videoId: string,
  metaId: string,
  positionMs: number,
  extra: { durationMs?: number; played?: boolean } = {}
) =>
  ({
    ...base,
    event,
    scope,
    videoId,
    metaId,
    positionMs,
    ...extra,
  }) as WatchStateEvent;
const mark = (
  event: 'played' | 'unplayed',
  scope: 'movie' | 'episode',
  videoId: string,
  metaId: string
) => ({ ...base, event, scope, videoId, metaId }) as WatchStateEvent;

const watchedOf = (watched: string | null | undefined) =>
  WatchedBitField.decode(watched, order).watchedIds();

describe('WatchedBitField.encode', () => {
  it('writes what decode reads back, anchored on the last watched video', () => {
    const field = WatchedBitField.empty(order);
    field.setVideo('tt0903747:1:1', true);
    field.setVideo('tt0903747:1:2', true);
    const encoded = field.encode()!;
    assert.match(encoded, /^tt0903747:1:2:2:/);
    assert.deepEqual(WatchedBitField.decode(encoded, order).watchedIds(), [
      'tt0903747:1:1',
      'tt0903747:1:2',
    ]);
  });

  it('still lines up after the show gains an episode before the anchor', () => {
    const field = WatchedBitField.empty(order);
    field.setVideo('tt0903747:2:1', true);
    const grown = ['tt0903747:0:1', ...order];
    assert.deepEqual(
      WatchedBitField.decode(field.encode(), grown).watchedIds(),
      ['tt0903747:2:1']
    );
  });
});

describe('applyEvent: resume points', () => {
  it('puts a title Stremio never saw into Continue Watching, not the library', () => {
    const item = applyEvent(
      newItem(film, 'movie', NOW),
      playback('pause', 'movie', 'tt0816692', 'tt0816692', 3_600_000, {
        durationMs: 10_140_000,
      }),
      null,
      NOW
    )!;
    assert.equal(item.state.timeOffset, 3_600_000);
    assert.equal(item.state.duration, 10_140_000);
    assert.equal(item.state.lastWatched, new Date(AT * 1000).toISOString());
    assert.equal(item.removed, true);
    assert.equal(item.temp, true);
    assert.equal(isInContinueWatching(item), true);
    assert.equal(item.name, 'Interstellar');
  });

  it('keeps a library title in the library and records the episode', () => {
    const inLibrary = {
      ...newItem(show, 'series', NOW),
      removed: false,
      temp: false,
    };
    const item = applyEvent(
      inLibrary,
      playback('stop', 'episode', 'tt0903747:1:2', 'tt0903747', 600_000, {
        durationMs: 2_820_000,
        played: false,
      }),
      show,
      NOW
    )!;
    assert.equal(item.removed, false);
    assert.equal(item.temp, false);
    assert.equal(item.state.video_id, 'tt0903747:1:2');
    assert.equal(item.state.timeOffset, 600_000);
  });

  it('ignores a start that never got going, and keeps a known duration when none is sent', () => {
    const start = newItem(film, 'movie', NOW);
    start.state.duration = 9_000_000;
    assert.equal(
      applyEvent(
        start,
        playback('start', 'movie', 'tt0816692', 'tt0816692', 0),
        null,
        NOW
      ),
      null
    );
    const item = applyEvent(
      start,
      playback('pause', 'movie', 'tt0816692', 'tt0816692', 5_000),
      null,
      NOW
    )!;
    assert.equal(item.state.duration, 9_000_000);
  });
});

describe('applyEvent: watched', () => {
  it('flags a finished film watched and takes it out of Continue Watching', () => {
    const watching = applyEvent(
      newItem(film, 'movie', NOW),
      playback('pause', 'movie', 'tt0816692', 'tt0816692', 3_600_000),
      null,
      NOW
    )!;
    const done = applyEvent(
      watching,
      playback('stop', 'movie', 'tt0816692', 'tt0816692', 10_000_000, {
        played: true,
      }),
      null,
      NOW
    )!;
    assert.equal(done.state.flaggedWatched, 1);
    assert.equal(done.state.timesWatched, 1);
    assert.equal(done.state.timeOffset, 0);
    assert.equal(isInContinueWatching(done), false);
    const cleared = applyEvent(
      done,
      mark('unplayed', 'movie', 'tt0816692', 'tt0816692'),
      null,
      NOW
    )!;
    assert.equal(cleared.state.flaggedWatched, 0);
    assert.equal(cleared.state.timesWatched, 0);
  });

  it('marks a finished episode and lines up the next one, as Stremio does', () => {
    const done = applyEvent(
      newItem(show, 'series', NOW),
      playback('stop', 'episode', 'tt0903747:1:1', 'tt0903747', 2_800_000, {
        played: true,
      }),
      show,
      NOW
    )!;
    assert.deepEqual(watchedOf(done.state.watched), ['tt0903747:1:1']);
    assert.equal(done.state.video_id, 'tt0903747:1:2');
    assert.equal(done.state.timeOffset, 1);
    assert.equal(isInContinueWatching(done), true);
  });

  it('leaves the last episode finished, with nothing after it', () => {
    const done = applyEvent(
      newItem(show, 'series', NOW),
      playback('stop', 'episode', 'tt0903747:2:1', 'tt0903747', 2_800_000, {
        played: true,
      }),
      show,
      NOW
    )!;
    assert.equal(done.state.video_id, 'tt0903747:2:1');
    assert.equal(done.state.timeOffset, 0);
  });

  it('marks and clears single episodes without moving Continue Watching', () => {
    const marked = applyEvent(
      newItem(show, 'series', NOW),
      mark('played', 'episode', 'tt0903747:1:2', 'tt0903747'),
      show,
      NOW
    )!;
    assert.deepEqual(watchedOf(marked.state.watched), ['tt0903747:1:2']);
    assert.equal(marked.state.timeOffset, 0);
    const cleared = applyEvent(
      marked,
      mark('unplayed', 'episode', 'tt0903747:1:2', 'tt0903747'),
      show,
      NOW
    )!;
    assert.deepEqual(watchedOf(cleared.state.watched), []);
  });

  it('marks a whole season in one event', () => {
    const bulk = {
      ...base,
      event: 'played',
      scope: 'season',
      metaId: 'tt0903747',
      season: 1,
      videos: [{ videoId: 'tt0903747:1:1' }, { videoId: 'tt0903747:1:2' }],
      part: 1,
      parts: 1,
    } as WatchStateEvent;
    const item = applyEvent(newItem(show, 'series', NOW), bulk, show, NOW)!;
    assert.deepEqual(watchedOf(item.state.watched), [
      'tt0903747:1:1',
      'tt0903747:1:2',
    ]);
    // Without the meta the marks can't be placed, so nothing is written.
    assert.equal(
      applyEvent(newItem(show, 'series', NOW), bulk, null, NOW),
      null
    );
  });
});

describe('applyEvent: library and the rest', () => {
  const list = (event: string) =>
    ({
      ...base,
      event,
      scope: 'movie',
      metaId: 'tt0816692',
    }) as WatchStateEvent;

  it('adds a favourite to the library and removes it again', () => {
    const added = applyEvent(
      newItem(film, 'movie', NOW),
      list('watchlisted'),
      null,
      NOW
    )!;
    assert.equal(added.removed, false);
    assert.equal(added.temp, false);
    const removed = applyEvent(added, list('unwatchlisted'), null, NOW)!;
    assert.equal(removed.removed, true);
  });

  it('leaves drops and ratings alone', () => {
    assert.equal(
      applyEvent(newItem(film, 'movie', NOW), list('dropped'), null, NOW),
      null
    );
  });

  it('stamps every write so Stremio keeps it over an older copy', () => {
    const old = { ...newItem(film, 'movie', NOW - 86_400_000) };
    const item = applyEvent(old, list('watchlisted'), null, NOW)!;
    assert.equal(item._mtime, new Date(NOW).toISOString());
  });
});

describe('manifest', () => {
  const stremio = {
    service: 'stremio' as const,
    authKey: 'k',
    library: true,
    writeBack: true,
  };

  it('asks for plays from AIOStreams when writing back to Stremio', () => {
    const push = manifestFor(stremio).watchState?.push;
    assert.deepEqual(push?.events, [
      'start',
      'pause',
      'stop',
      'played',
      'unplayed',
      'watchlisted',
      'unwatchlisted',
    ]);
    assert.equal(push?.bulk, true);
  });

  it('only reads when write-back is off, or for Nuvio', () => {
    assert.equal(
      manifestFor({ ...stremio, writeBack: false }).watchState?.push,
      undefined
    );
    assert.equal(
      manifestFor({
        service: 'nuvio',
        session: 's',
        key: 'k',
        profile: 1,
        library: true,
      }).watchState?.push,
      undefined
    );
  });
});
