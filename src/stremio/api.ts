import { readJson, UpstreamError } from '../http.js';
import type { LibraryItem } from './library-item.js';

const API = 'https://api.strem.io/api';
const LIBRARY_COLLECTION = 'libraryItem';

export class StremioAuthError extends Error {}

/** Stremio understood the request and refused it. */
export class StremioError extends Error {}

const NO_SESSION = 1;

interface Envelope<T> {
  result?: T | null;
  error?: { code?: number; message?: string } | string | null;
}

async function call<T>(method: string, body: object): Promise<T> {
  const { status, json } = await readJson(`${API}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    timeoutMs: 30_000,
    maxBytes: 32 * 1024 * 1024,
  });
  const envelope = json as Envelope<T> | null;
  if (!envelope || typeof envelope !== 'object') {
    throw new UpstreamError(`Stremio ${method}: HTTP ${status}, not JSON`);
  }
  if (envelope.error) {
    const error =
      typeof envelope.error === 'string'
        ? { message: envelope.error }
        : envelope.error;
    const message = `Stremio ${method}: ${error.message ?? 'unknown error'}`;
    if (error.code === NO_SESSION) throw new StremioAuthError(message);
    throw new StremioError(message);
  }
  if (status === 401 || status === 403) {
    throw new StremioAuthError(`Stremio ${method}: HTTP ${status}`);
  }
  return envelope.result as T;
}

export interface StremioUser {
  _id: string;
  email?: string;
}

export function getUser(authKey: string): Promise<StremioUser> {
  return call('getUser', { type: 'GetUser', authKey });
}

/** Every item's id and modification time in milliseconds. */
export function libraryMeta(authKey: string): Promise<[string, number][]> {
  return call('datastoreMeta', { authKey, collection: LIBRARY_COLLECTION });
}

export function libraryGet(authKey: string): Promise<LibraryItem[]> {
  return call('datastoreGet', {
    authKey,
    collection: LIBRARY_COLLECTION,
    ids: [],
    all: true,
  });
}

/** The library items with these ids; missing and malformed ones are left out. */
export async function libraryGetIds(
  authKey: string,
  ids: string[]
): Promise<LibraryItem[]> {
  const items = await call<unknown>('datastoreGet', {
    authKey,
    collection: LIBRARY_COLLECTION,
    ids,
    all: false,
  });
  if (!Array.isArray(items)) return [];
  return items.filter(
    (item): item is LibraryItem =>
      !!item &&
      typeof item === 'object' &&
      typeof item._id === 'string' &&
      !!item._id &&
      !!item.state &&
      typeof item.state === 'object'
  );
}

/** Writes whole items; Stremio keeps the one with the newest `_mtime`. */
export async function libraryPut(
  authKey: string,
  items: LibraryItem[]
): Promise<void> {
  await call('datastorePut', {
    authKey,
    collection: LIBRARY_COLLECTION,
    changes: items,
  });
}

export interface AddonDescriptor {
  transportUrl: string;
  manifest?: {
    types?: string[];
    idPrefixes?: string[] | null;
    resources?: (
      string | { name: string; types?: string[]; idPrefixes?: string[] | null }
    )[];
  };
}

export async function addonCollection(
  authKey: string
): Promise<AddonDescriptor[]> {
  const result = await call<{ addons?: AddonDescriptor[] | null }>(
    'addonCollectionGet',
    { type: 'AddonCollectionGet', authKey, update: true }
  );
  return result?.addons ?? [];
}
