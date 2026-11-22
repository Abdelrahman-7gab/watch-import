import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { libraryGetIds } from './api.js';

async function answering<T>(body: unknown, run: () => Promise<T>) {
  const real = globalThis.fetch;
  globalThis.fetch = (async () => Response.json(body)) as typeof fetch;
  try {
    return await run();
  } finally {
    globalThis.fetch = real;
  }
}

describe('libraryGetIds', () => {
  it('reads a null or missing result as no items', async () => {
    assert.deepEqual(
      await answering({ result: null }, () => libraryGetIds('a', ['tt1'])),
      []
    );
    assert.deepEqual(
      await answering({}, () => libraryGetIds('a', ['tt1'])),
      []
    );
  });

  it('leaves out entries that are not library items', async () => {
    const item = { _id: 'tt1', name: 'One', state: { timeOffset: 0 } };
    const items = await answering(
      { result: [item, null, { name: 'no id' }, { _id: 'tt2' }, 'junk'] },
      () => libraryGetIds('a', ['tt1', 'tt2'])
    );
    assert.deepEqual(items, [item]);
  });

  it('reads a result that is not a list as no items', async () => {
    assert.deepEqual(
      await answering({ result: { _id: 'tt1' } }, () =>
        libraryGetIds('a', ['tt1'])
      ),
      []
    );
  });
});
