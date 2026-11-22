import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { serially } from './serially.js';

describe('serially', () => {
  it('runs tasks for one key in order', async () => {
    const seen: number[] = [];
    const slow = serially('k', async () => {
      await new Promise((r) => setTimeout(r, 20));
      seen.push(1);
    });
    const fast = serially('k', async () => {
      seen.push(2);
    });
    await Promise.all([slow, fast]);
    assert.deepEqual(seen, [1, 2]);
  });

  it('rejects to its caller only, never as an unhandled rejection', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      await assert.rejects(
        serially('fails', async () => {
          throw new Error('Stremio is down');
        }),
        /Stremio is down/
      );
      await new Promise((r) => setTimeout(r, 20));
      assert.deepEqual(unhandled, []);
      const after = await serially('fails', async () => 'next one runs');
      assert.equal(after, 'next one runs');
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});
