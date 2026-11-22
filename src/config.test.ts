import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ConfigSchema } from './config.js';

describe('ConfigSchema', () => {
  it('keeps install links from before write-back read-only', () => {
    const old = ConfigSchema.parse({
      service: 'stremio',
      authKey: 'a',
      library: true,
    });
    assert.equal(old.writeBack, false);
    const nuvio = ConfigSchema.parse({
      service: 'nuvio',
      session: 's',
      key: 'k',
    });
    assert.equal(nuvio.writeBack, false);
  });

  it('writes back when the link asks for it', () => {
    const config = ConfigSchema.parse({
      service: 'stremio',
      authKey: 'a',
      writeBack: true,
    });
    assert.equal(config.writeBack, true);
  });
});
