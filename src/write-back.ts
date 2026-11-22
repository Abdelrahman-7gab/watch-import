import type { WatchStateEvent } from '@aiostreams/addon-sdk';
import type { Config, NuvioConfig, StremioConfig } from './config.js';
import { pushToNuvio } from './nuvio/push.js';
import { pushToStremio } from './stremio/push.js';

/** The writer for each service; tests pass their own. */
export interface Writers {
  stremio: (config: StremioConfig, event: WatchStateEvent) => Promise<void>;
  nuvio: (config: NuvioConfig, event: WatchStateEvent) => Promise<void>;
}

const live: Writers = {
  stremio: (config, event) => pushToStremio(config, event),
  nuvio: (config, event) => pushToNuvio(config, event),
};

/**
 * Writes one AIOStreams event back to the link's service.
 *
 * No write-back check here: the SDK's router answers 404 to a push when the
 * manifest has no `watchState.push`, and the manifest only has one when
 * `writeBack` is on. It does not filter by event, though, so the library
 * events the manifest leaves out with the library off are dropped here.
 */
export async function pushEvent(
  config: Config,
  event: WatchStateEvent,
  writers: Writers = live
): Promise<void> {
  if (
    !config.library &&
    (event.event === 'watchlisted' || event.event === 'unwatchlisted')
  )
    return;
  if (config.service === 'stremio') await writers.stremio(config, event);
  else await writers.nuvio(config, event);
}
