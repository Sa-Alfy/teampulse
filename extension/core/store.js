/**
 * extension/core/store.js — Browser-safe persistence layer.
 *
 * Replicates the SQLite semantics from db.js + build-digest.js using
 * chrome.storage.local (or an in-memory backend for tests).
 *
 * Key namespace: tp:v1:<kind>:<className> and tp:v1:seen-hashes
 *
 * Semantics (from build-digest.js):
 *   - filter FIRST (isNoteworthy), dedup SECOND
 *   - filtered-out posts are recorded with surfaced=false and are NEVER
 *     counted as seen — so improving the classifier can still surface them
 *   - a hash is "seen" only when surfaced=true
 *   - "new" means seen_at is within newWindowHours of now (time-window, not absence)
 *
 * Dual export: CJS in Node, globalThis.TP in browser.
 */

"use strict";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_POSTS_PER_CLASS = 200; // cap stored posts per class; never prune seen hashes
const KEY_PREFIX          = "tp:v1:";
const KEY_SEEN_HASHES     = `${KEY_PREFIX}seen-hashes`;
const KEY_POSTS_PFX       = `${KEY_PREFIX}posts:`;
const KEY_ASSIGN_PFX      = `${KEY_PREFIX}assignments:`;
const KEY_SYNC_PFX        = `${KEY_PREFIX}last-sync:`;

// ---------------------------------------------------------------------------
// Backends
// ---------------------------------------------------------------------------

/**
 * Backend backed by chrome.storage.local (promise-returning shape from MV3).
 * @returns {{ get(keys: string[]): Promise<object>, set(obj: object): Promise<void>, remove(keys: string[]): Promise<void> }}
 */
function chromeBackend() {
  return {
    get(keys) {
      return new Promise((resolve, reject) => {
        chrome.storage.local.get(keys, (result) => {
          if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
          resolve(result);
        });
      });
    },
    set(obj) {
      return new Promise((resolve, reject) => {
        chrome.storage.local.set(obj, () => {
          if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
          resolve();
        });
      });
    },
    remove(keys) {
      return new Promise((resolve, reject) => {
        chrome.storage.local.remove(keys, () => {
          if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
          resolve();
        });
      });
    },
  };
}

/**
 * In-memory backend for tests — no chrome APIs required.
 * @returns {object}
 */
function memoryBackend() {
  const store = {};
  return {
    get(keys) {
      const result = {};
      for (const k of keys) {
        if (Object.prototype.hasOwnProperty.call(store, k)) result[k] = store[k];
      }
      return Promise.resolve(result);
    },
    set(obj) {
      Object.assign(store, obj);
      return Promise.resolve();
    },
    remove(keys) {
      for (const k of keys) delete store[k];
      return Promise.resolve();
    },
    // expose raw store for test assertions
    _raw: store,
  };
}

// ---------------------------------------------------------------------------
// Store factory
// ---------------------------------------------------------------------------

/**
 * Create a store backed by `backend`.
 *
 * @param {{ get, set, remove }} backend
 * @returns {object} store API
 */
function createStore(backend) {
  // Promise queue — serialise all writes so concurrent ingests never lose data.
  let _queue = Promise.resolve();

  function enqueue(fn) {
    _queue = _queue.then(fn, fn); // keep chain alive on error
    return _queue;
  }

  // ----- helpers -----

  function postsKey(className)  { return `${KEY_POSTS_PFX}${className}`; }
  function assignKey(className) { return `${KEY_ASSIGN_PFX}${className}`; }
  function syncKey(className)   { return `${KEY_SYNC_PFX}${className}`; }

  /**
   * Read the seen-hash map from storage.
   * Shape: { [hash]: { seenAt: isoString, surfaced: boolean } }
   */
  async function readSeenHashes() {
    const data = await backend.get([KEY_SEEN_HASHES]);
    return data[KEY_SEEN_HASHES] || {};
  }

  /**
   * Read posts for one class.
   * Shape: { [hash]: { post, className, seenAt, surfaced } }
   */
  async function readPosts(className) {
    const data = await backend.get([postsKey(className)]);
    return data[postsKey(className)] || {};
  }

  // ----- public API -----

  /**
   * Ingest a batch of raw posts for one class, applying the same logic as
   * build-digest.js: filter FIRST, dedup (seen-hash map) SECOND.
   *
   * @param {string}   className   — raw class name
   * @param {object[]} posts       — from scrape-posts.js
   * @param {string}   nowIso      — ISO timestamp for this ingest
   * @param {Function} hashFn      — async (className, post) => hexString
   * @param {Function} isNoteworthyFn — (post) => boolean
   * @returns {Promise<{scanned, new: number, alreadySeen, filteredOut}>}
   */
  async function ingestPosts(className, posts, nowIso, hashFn, isNoteworthyFn) {
    return enqueue(async () => {
      const seenHashes  = await readSeenHashes();
      const storedPosts = await readPosts(className);

      let scanned     = 0;
      let newCount    = 0;
      let alreadySeen = 0;
      let filteredOut = 0;

      // Per-batch duplicate guard (mirrors seenThisRun in build-digest.js)
      const seenThisBatch = new Set();

      for (const post of (posts || [])) {
        scanned++;

        const hash = await hashFn(className, post);

        // Filter FIRST
        if (!isNoteworthyFn(post)) {
          filteredOut++;
          // Record with surfaced=false — not burned as seen
          if (!storedPosts[hash]) {
            storedPosts[hash] = {
              post,
              className,
              seenAt: nowIso,
              surfaced: false,
            };
          }
          continue;
        }

        // In-batch dedup
        if (seenThisBatch.has(hash)) continue;
        seenThisBatch.add(hash);

        const existingHash = seenHashes[hash];
        if (existingHash && existingHash.surfaced) {
          alreadySeen++;
          // Still update stored post record
          if (!storedPosts[hash]) {
            storedPosts[hash] = { post, className, seenAt: existingHash.seenAt, surfaced: true };
          }
        } else {
          // Genuinely new — mark surfaced
          newCount++;
          seenHashes[hash] = { seenAt: nowIso, surfaced: true };
          storedPosts[hash] = { post, className, seenAt: nowIso, surfaced: true };
        }
      }

      // Cap stored posts per class (keep newest by seenAt)
      const postEntries = Object.entries(storedPosts);
      if (postEntries.length > MAX_POSTS_PER_CLASS) {
        postEntries.sort((a, b) => (b[1].seenAt || "") > (a[1].seenAt || "") ? 1 : -1);
        const trimmed = {};
        for (const [k, v] of postEntries.slice(0, MAX_POSTS_PER_CLASS)) trimmed[k] = v;
        await backend.set({
          [postsKey(className)]: trimmed,
          [syncKey(className)]: nowIso,
          [KEY_SEEN_HASHES]: seenHashes,
        });
      } else {
        await backend.set({
          [postsKey(className)]: storedPosts,
          [syncKey(className)]: nowIso,
          [KEY_SEEN_HASHES]: seenHashes,
        });
      }

      return { scanned, new: newCount, alreadySeen, filteredOut };
    });
  }

  /**
   * Replace a class's assignment list entirely.
   *
   * @param {string}   className
   * @param {object[]} assignments
   * @param {string}   nowIso
   */
  async function ingestAssignments(className, assignments, nowIso) {
    return enqueue(async () => {
      await backend.set({
        [assignKey(className)]: assignments || [],
        [syncKey(className)]: nowIso,
      });
    });
  }

  /**
   * Return the full store state: all classes, seen-hash map, last-sync times.
   * @returns {Promise<object>}
   */
  async function getState() {
    // Discover all class keys
    const seenData = await backend.get([KEY_SEEN_HASHES]);
    const seenHashes = seenData[KEY_SEEN_HASHES] || {};

    // We need to enumerate all known class names. They're discoverable from
    // all keys in the backend only if backend exposes _raw (memoryBackend).
    // For chromeBackend we'd need chrome.storage.local.get(null) — expose a
    // helper to enumerate keys. For now, return what we have.
    // Callers that built state incrementally can pass it in; this is useful
    // for shape.js which works from state already assembled by the SW.
    return { seenHashes, classes: {} };
  }

  /**
   * Full-read getState that uses the provided list of class names to load all
   * posts, assignments, and sync timestamps.
   *
   * @param {string[]} classNames
   * @returns {Promise<object>}
   */
  async function getFullState(classNames) {
    const allKeys = [KEY_SEEN_HASHES];
    for (const cn of classNames) {
      allKeys.push(postsKey(cn), assignKey(cn), syncKey(cn));
    }

    const data = await backend.get(allKeys);
    const seenHashes = data[KEY_SEEN_HASHES] || {};
    const classes = {};

    for (const cn of classNames) {
      classes[cn] = {
        posts:       data[postsKey(cn)]  || {},
        assignments: data[assignKey(cn)] || [],
        lastSync:    data[syncKey(cn)]   || null,
      };
    }

    return { seenHashes, classes };
  }

  /**
   * Wipe all tp:v1:* keys from storage.
   */
  async function clearAll() {
    return enqueue(async () => {
      // For memoryBackend with _raw we can enumerate; for chrome we'd use
      // chrome.storage.local.clear(). Expose both paths:
      if (backend._raw) {
        for (const k of Object.keys(backend._raw)) {
          if (k.startsWith(KEY_PREFIX)) delete backend._raw[k];
        }
        return;
      }
      // Chrome: get all keys first (null = all items)
      const allData = await new Promise((resolve, reject) => {
        chrome.storage.local.get(null, (items) => {
          if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
          resolve(items);
        });
      });
      const tpKeys = Object.keys(allData).filter((k) => k.startsWith(KEY_PREFIX));
      if (tpKeys.length > 0) await backend.remove(tpKeys);
    });
  }

  return {
    ingestPosts,
    ingestAssignments,
    getState,
    getFullState,
    clearAll,
    // expose constants for consumers
    MAX_POSTS_PER_CLASS,
    KEY_PREFIX,
  };
}

const _store = { createStore, chromeBackend, memoryBackend, MAX_POSTS_PER_CLASS };

if (typeof module !== "undefined" && module.exports) {
  module.exports = _store;
} else {
  globalThis.TP = Object.assign(globalThis.TP || {}, _store);
}
