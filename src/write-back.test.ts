import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { WatchStateEvent } from '@aiostreams/addon-sdk';
import type { Config } from './config.js';
import { pushEvent } from './write-back.js';

const event = (name: string) =>
  ({
    id: 'e',
    at: 1,
    ids: {},
    event: name,
    scope: 'movie',
    metaId: 'tt0816692',
    videoId: 'tt0816692',
  }) as WatchStateEvent;

const stremio = (library: boolean): Config => ({
  service: 'stremio',
  authKey: 'a',
  library,
  writeBack: true,
});
const nuvio = (library: boolean): Config => ({
  service: 'nuvio',
  session: 's',
  key: 'k',
  profile: 1,
  library,
  writeBack: true,
});

/** What reached each writer. */
async function written(config: Config, name: string): Promise<string[]> {
  const seen: string[] = [];
  await pushEvent(config, event(name), {
    stremio: async (_, e) => {
      seen.push(`stremio ${e.event}`);
    },
    nuvio: async (_, e) => {
      seen.push(`nuvio ${e.event}`);
    },
  });
  return seen;
}

describe('pushEvent', () => {
  it('never touches the library when the library is not imported', async () => {
    for (const config of [stremio(false), nuvio(false)]) {
      assert.deepEqual(await written(config, 'watchlisted'), []);
      assert.deepEqual(await written(config, 'unwatchlisted'), []);
    }
  });

  it('still writes plays and marks with the library off', async () => {
    assert.deepEqual(await written(stremio(false), 'played'), [
      'stremio played',
    ]);
    assert.deepEqual(await written(nuvio(false), 'played'), ['nuvio played']);
  });

  it('writes library events when the library is imported', async () => {
    assert.deepEqual(await written(stremio(true), 'watchlisted'), [
      'stremio watchlisted',
    ]);
    assert.deepEqual(await written(nuvio(true), 'unwatchlisted'), [
      'nuvio unwatchlisted',
    ]);
  });
});
