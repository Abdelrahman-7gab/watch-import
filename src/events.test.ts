import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { WatchStateEvent } from '@aiostreams/addon-sdk';
import { isFinished, stampOf } from './events.js';

const NOW = Date.UTC(2026, 10, 22, 20, 0, 0);
const event = (fields: Record<string, unknown>) =>
  ({
    id: 'e',
    at: NOW / 1000 - 60,
    ids: {},
    scope: 'movie',
    metaId: 'tt0816692',
    videoId: 'tt0816692',
    ...fields,
  }) as WatchStateEvent;

describe('stampOf', () => {
  it("is the event's time in milliseconds", () => {
    assert.equal(stampOf(event({ event: 'pause' }), NOW), NOW - 60_000);
  });

  it('never lies in the future, and falls back to now for a missing time', () => {
    assert.equal(
      stampOf(event({ event: 'pause', at: NOW / 1000 + 60 }), NOW),
      NOW
    );
    assert.equal(stampOf(event({ event: 'pause', at: 0 }), NOW), NOW);
    assert.equal(stampOf(event({ event: 'pause', at: Number.NaN }), NOW), NOW);
  });
});

describe('isFinished', () => {
  it('is a watched mark or a play that got past the played threshold', () => {
    assert.equal(isFinished(event({ event: 'played' })), true);
    assert.equal(isFinished(event({ event: 'stop', played: true })), true);
    assert.equal(isFinished(event({ event: 'stop', played: false })), false);
    assert.equal(isFinished(event({ event: 'stop' })), false);
    assert.equal(isFinished(event({ event: 'pause', played: true })), false);
    assert.equal(isFinished(event({ event: 'unplayed' })), false);
    assert.equal(isFinished(event({ event: 'watchlisted' })), false);
  });
});
