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
const KEY_CLASS_INDEX     = `${KEY_PREFIX}class-index`;
const KEY_POSTS_PFX       = `${KEY_PREFIX}posts:`;
const KEY_ASSIGN_PFX      = `${KEY_PREFIX}assignments:`;
const KEY_SYNC_PFX        = `${KEY_PREFIX}last-sync:`;
const KEY_HEALTH          = `${KEY_PREFIX}scrape-health`;
const KEY_KNOWN_CLASSES   = `${KEY_PREFIX}known-classes`;  // class names seen in Teams navigation
const KEY_CAPTURE_REPORT  = `${KEY_PREFIX}capture-report`; // last assignments capture report
const MAX_KNOWN_CLASSES   = 300;

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
      if (keys === null) {
        Object.assign(result, store);
        return Promise.resolve(result);
      }
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
      const list = Array.isArray(keys) ? keys : [keys];
      for (const k of list) delete store[k];
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
   * Read the list of known class names from storage.
   * Shape: string[]
   */
  async function readClassIndex() {
    const data = await backend.get([KEY_CLASS_INDEX]);
    return Array.isArray(data[KEY_CLASS_INDEX]) ? data[KEY_CLASS_INDEX] : [];
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
      const seenHashes   = await readSeenHashes();
      const storedPosts  = await readPosts(className);
      const classIndex   = await readClassIndex();
      const updatedIndex = classIndex.includes(className) ? classIndex : [...classIndex, className];

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
      let postsToSave = storedPosts;
      if (postEntries.length > MAX_POSTS_PER_CLASS) {
        postEntries.sort((a, b) => (b[1].seenAt || "") > (a[1].seenAt || "") ? 1 : -1);
        const trimmed = {};
        for (const [k, v] of postEntries.slice(0, MAX_POSTS_PER_CLASS)) trimmed[k] = v;
        postsToSave = trimmed;
      }

      await backend.set({
        [postsKey(className)]: postsToSave,
        [syncKey(className)]: nowIso,
        [KEY_SEEN_HASHES]: seenHashes,
        [KEY_CLASS_INDEX]: updatedIndex,
      });

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
      const classIndex   = await readClassIndex();
      const updatedIndex = classIndex.includes(className) ? classIndex : [...classIndex, className];
      await backend.set({
        [assignKey(className)]: assignments || [],
        [syncKey(className)]: nowIso,
        [KEY_CLASS_INDEX]: updatedIndex,
      });
    });
  }

  /**
   * Merge a capture into a class's assignment list without losing data:
   * only the tabs in okTabs (captured and confirmed loaded) are replaced;
   * stored items of other tabs are kept unless the same assignment was just
   * captured under another tab. A class with nothing stored and nothing new
   * is not created.
   *
   * @param {string}   className
   * @param {object[]} items    — captured items (any tab)
   * @param {string[]} okTabs   — tabs whose capture is authoritative
   * @param {string}   nowIso
   * @returns {Promise<{ written: boolean, kept: number, added: number }>}
   */
  async function mergeAssignments(className, items, okTabs, nowIso) {
    return enqueue(async () => {
      const ok = new Set(okTabs || []);
      const fresh = (items || []).filter((a) => ok.has(a.tab));
      const idOf = (a) => a.assignmentId || a.rawId || null;
      const freshIds = new Set(fresh.map(idOf).filter(Boolean));
      const data = await backend.get([assignKey(className), KEY_CLASS_INDEX]);
      const cur = Array.isArray(data[assignKey(className)]) ? data[assignKey(className)] : [];
      const kept = cur.filter((a) => !ok.has(a.tab) && !(idOf(a) && freshIds.has(idOf(a))));
      if (cur.length === 0 && fresh.length === 0) return { written: false, kept: 0, added: 0 };
      const classIndex = Array.isArray(data[KEY_CLASS_INDEX]) ? data[KEY_CLASS_INDEX] : [];
      await backend.set({
        [assignKey(className)]: [...kept, ...fresh],
        [syncKey(className)]: nowIso,
        [KEY_CLASS_INDEX]: classIndex.includes(className) ? classIndex : [...classIndex, className],
      });
      return { written: true, kept: kept.length, added: fresh.length };
    });
  }

  /** Remember a class name seen in Teams navigation (validates card class names). */
  async function noteClass(className) {
    return enqueue(async () => {
      const data = await backend.get([KEY_KNOWN_CLASSES]);
      const list = Array.isArray(data[KEY_KNOWN_CLASSES]) ? data[KEY_KNOWN_CLASSES] : [];
      if (list.includes(className)) return;
      await backend.set({ [KEY_KNOWN_CLASSES]: [...list, className].slice(-MAX_KNOWN_CLASSES) });
    });
  }

  /** Class names seen in navigation plus classes that have stored posts. */
  async function getKnownClasses() {
    const index = await readClassIndex();
    const data = await backend.get([KEY_KNOWN_CLASSES, ...index.map(postsKey)]);
    const known = new Set(Array.isArray(data[KEY_KNOWN_CLASSES]) ? data[KEY_KNOWN_CLASSES] : []);
    for (const cn of index) {
      const posts = data[postsKey(cn)];
      if (posts && Object.keys(posts).length > 0) known.add(cn);
    }
    return [...known];
  }

  async function setCaptureReport(report) {
    return enqueue(() => backend.set({ [KEY_CAPTURE_REPORT]: report }));
  }

  async function getCaptureReport() {
    const data = await backend.get([KEY_CAPTURE_REPORT]);
    return data[KEY_CAPTURE_REPORT] || null;
  }

  /**
   * Record a scraper problem reported by a content script.
   * className === null → page-level problem (class could not be resolved).
   * Success is not recorded here: a later last-sync timestamp supersedes it.
   *
   * Shape: { global: {status, at} | null, classes: { [className]: {status, at} } }
   *
   * @param {string|null} className
   * @param {string}      status   — "no-class" | "no-messages"
   * @param {string}      nowIso
   */
  async function recordHealth(className, status, nowIso) {
    return enqueue(async () => {
      const data   = await backend.get([KEY_HEALTH]);
      const health = data[KEY_HEALTH] || { global: null, classes: {} };
      if (!health.classes) health.classes = {};
      const entry = { status, at: nowIso };
      if (className === null) health.global = entry;
      else health.classes[className] = entry;
      await backend.set({ [KEY_HEALTH]: health });
    });
  }

  /**
   * Return the full store state: all classes, seen-hash map, last-sync times.
   * Reads the class index and returns { seenHashes, classes: { [className]: { posts, assignments, lastSync } } }.
   * @returns {Promise<object>}
   */
  async function getState() {
    const classNames = await readClassIndex();
    return getFullState(classNames);
  }

  /**
   * Full-read getState that uses the provided list of class names to load all
   * posts, assignments, and sync timestamps.
   *
   * @param {string[]} classNames
   * @returns {Promise<object>}
   */
  async function getFullState(classNames) {
    const allKeys = [KEY_SEEN_HASHES, KEY_HEALTH];
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

    const scrapeHealth = data[KEY_HEALTH] || { global: null, classes: {} };
    return { seenHashes, classes, scrapeHealth };
  }

  /**
   * Wipe all tp:v1:* keys from storage.
   */
  async function clearAll() {
    return enqueue(async () => {
      const allData = await backend.get(null);
      const tpKeys = Object.keys(allData || {}).filter((k) => k.startsWith(KEY_PREFIX));
      if (tpKeys.length > 0) {
        await backend.remove(tpKeys);
      }
    });
  }

  return {
    ingestPosts,
    ingestAssignments,
    mergeAssignments,
    noteClass,
    getKnownClasses,
    setCaptureReport,
    getCaptureReport,
    recordHealth,
    getState,
    getFullState,
    clearAll,
    // expose constants for consumers
    MAX_POSTS_PER_CLASS,
    KEY_PREFIX,
    KEY_CLASS_INDEX,
  };
}

const _store = { createStore, chromeBackend, memoryBackend, MAX_POSTS_PER_CLASS, KEY_PREFIX, KEY_CLASS_INDEX, KEY_HEALTH, KEY_CAPTURE_REPORT, KEY_KNOWN_CLASSES };

if (typeof module !== "undefined" && module.exports) {
  module.exports = _store;
} else {
  globalThis.TP = Object.assign(globalThis.TP || {}, _store);
}
