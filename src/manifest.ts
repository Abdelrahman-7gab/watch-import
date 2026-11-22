import type { Manifest } from '@aiostreams/addon-sdk';
import type { Config } from './config.js';

const VERSION = '0.1.0';

const SERVICES = { stremio: 'Stremio', nuvio: 'Nuvio' } as const;

export function manifestFor(config?: Config): Manifest {
  const service = config && SERVICES[config.service];
  return {
    id: 'community.watch-import',
    version: VERSION,
    name: service ? `Watch Import (${service})` : 'Watch Import',
    description: config?.writeBack
      ? `Keeps ${service} and AIOStreams in step: your ${service} history, Continue Watching and library come into AIOStreams, and what you watch through AIOStreams goes back to ${service}.`
      : 'Brings your watch history, Continue Watching and library from Stremio or Nuvio into AIOStreams, and keeps them up to date.',
    types: ['movie', 'series'],
    resources: [{ name: 'watch_state', types: ['movie', 'series', 'anime'] }],
    watchState: {
      version: 2,
      ...(config?.writeBack
        ? {
            push: {
              events: [
                'start',
                'pause',
                'stop',
                'played',
                'unplayed',
                ...(config.library
                  ? (['watchlisted', 'unwatchlisted'] as const)
                  : []),
              ],
              bulk: true,
            },
          }
        : {}),
      pull: {
        items: true,
        watched: true,
        watchlist: config?.library ?? true,
        ttlSeconds: 300,
      },
    },
    behaviorHints: { configurable: true, configurationRequired: true },
  };
}
