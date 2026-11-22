import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

// Meta lookups go through the global fetch, which these tests replace, only when private URLs are allowed.
process.env.ALLOW_PRIVATE_ADDON_URLS = 'true';
const { resolvePublicMeta } = await import('./meta.js');
const { UpstreamError } = await import('../http.js');

const real = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = real;
});

/** Answers every meta request with `answer(url)`, recording the URLs asked. */
function serve(answer: (url: string) => Response | Promise<Response>) {
  const asked: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    asked.push(url);
    return answer(url);
  }) as typeof fetch;
  return asked;
}

const meta = (id: string, name: string) =>
  Response.json({ meta: { id, type: 'series', name, videos: [] } });

describe('resolvePublicMeta', () => {
  it('finds the title in the public addons', async () => {
    serve(() => meta('tt1000001', 'Found'));
    const found = await resolvePublicMeta('series', 'tt1000001', 'acct');
    assert.equal(found?.name, 'Found');
  });

  it('is null only when every source answered that it does not know the title', async () => {
    serve(() => new Response('{}', { status: 404 }));
    assert.equal(await resolvePublicMeta('series', 'tt1000002', 'acct'), null);
  });

  it('throws, so the push is retried, when no source could be asked', async () => {
    serve(() => new Response('down', { status: 503 }));
    await assert.rejects(
      resolvePublicMeta('series', 'tt1000003', 'acct'),
      UpstreamError
    );
  });

  it("queues one account's lookups apart from another's", async () => {
    const held: (() => void)[] = [];
    const asked = serve(
      (url) =>
        new Promise<Response>((resolve) =>
          held.push(() => resolve(meta(url.split('/').pop()!, 'x')))
        )
    );
    const busy = [1, 2, 3, 4, 5].map((n) =>
      resolvePublicMeta('series', `tt200000${n}`, 'busy')
    );
    const other = resolvePublicMeta('series', 'tt2000009', 'other');
    await new Promise((r) => setTimeout(r, 20));
    // Four of the busy account's run at once; the other account is not stuck behind its fifth.
    assert.ok(
      asked.some((url) => url.includes('tt2000009')),
      `the other account was not asked: ${asked.length} requests`
    );
    let settled = false;
    const all = Promise.all([...busy, other]).finally(() => {
      settled = true;
    });
    while (!settled) {
      held.shift()?.();
      await new Promise((r) => setTimeout(r, 1));
    }
    await all;
  });
});
