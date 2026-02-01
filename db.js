const DB_NAME = 'TwitterScrapeDB';
const DB_VERSION = 4;

let dbInstance = null;

export function openDB() {
  if (dbInstance) return Promise.resolve(dbInstance);

  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      const tx = event.target.transaction;

      if (!db.objectStoreNames.contains('tweets')) {
        const tweetStore = db.createObjectStore('tweets', { keyPath: 'tweetId' });
        tweetStore.createIndex('byUser', 'handle', { unique: false });
        tweetStore.createIndex('byTimestamp', 'timestamp', { unique: false });
        tweetStore.createIndex('byUserAndTime', ['handle', 'timestamp'], { unique: false });
      }

      if (!db.objectStoreNames.contains('users')) {
        const userStore = db.createObjectStore('users', { keyPath: 'handle' });
        // V4: Add index for sorted retrieval (starred desc, tweetCount desc)
        userStore.createIndex('bySortOrder', ['starred', 'tweetCount'], { unique: false });
      } else if (event.oldVersion < 4) {
        // Add index to existing store
        const userStore = tx.objectStore('users');
        if (!userStore.indexNames.contains('bySortOrder')) {
          userStore.createIndex('bySortOrder', ['starred', 'tweetCount'], { unique: false });
        }
      }

      if (!db.objectStoreNames.contains('settings')) {
        db.createObjectStore('settings', { keyPath: 'key' });
      }

      // V3: Add dedicated blockedUsers store for O(1) lookup
      if (!db.objectStoreNames.contains('blockedUsers')) {
        db.createObjectStore('blockedUsers', { keyPath: 'handle' });

        // Migrate existing blocked users from settings array
        if (event.oldVersion < 3 && event.oldVersion > 0) {
          const settingsStore = tx.objectStore('settings');
          const getReq = settingsStore.get('blockedUsers');
          getReq.onsuccess = () => {
            const oldBlocked = getReq.result?.value || [];
            if (oldBlocked.length > 0) {
              const blockedStore = tx.objectStore('blockedUsers');
              for (const handle of oldBlocked) {
                blockedStore.put({ handle, blockedAt: new Date().toISOString() });
              }
              // Clean up old settings entry
              settingsStore.delete('blockedUsers');
            }
          };
        }
      }
    };

    request.onsuccess = (event) => {
      dbInstance = event.target.result;
      dbInstance.onclose = () => { dbInstance = null; };
      resolve(dbInstance);
    };

    request.onerror = (event) => {
      reject(event.target.error);
    };
  });
}

// --- Settings helpers ---

async function getSetting(key, defaultValue) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('settings', 'readonly');
    const req = tx.objectStore('settings').get(key);
    req.onsuccess = () => resolve(req.result ? req.result.value : defaultValue);
    req.onerror = (e) => reject(e.target.error);
  });
}

async function setSetting(key, value) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('settings', 'readwrite');
    const req = tx.objectStore('settings').put({ key, value });
    req.onsuccess = () => resolve();
    req.onerror = (e) => reject(e.target.error);
  });
}

// --- Blocked users (O(1) lookup via dedicated store) ---

export async function getBlockedUsers() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('blockedUsers', 'readonly');
    const req = tx.objectStore('blockedUsers').getAll();
    req.onsuccess = () => resolve(req.result.map(r => r.handle));
    req.onerror = (e) => reject(e.target.error);
  });
}

export async function blockUser(handle) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('blockedUsers', 'readwrite');
    const req = tx.objectStore('blockedUsers').put({
      handle,
      blockedAt: new Date().toISOString()
    });
    req.onsuccess = () => resolve();
    req.onerror = (e) => reject(e.target.error);
  });
}

export async function unblockUser(handle) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('blockedUsers', 'readwrite');
    const req = tx.objectStore('blockedUsers').delete(handle);
    req.onsuccess = () => resolve();
    req.onerror = (e) => reject(e.target.error);
  });
}

export async function isBlocked(handle) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('blockedUsers', 'readonly');
    const req = tx.objectStore('blockedUsers').get(handle);
    req.onsuccess = () => resolve(!!req.result);
    req.onerror = (e) => reject(e.target.error);
  });
}

// --- Capture settings ---

export async function getCaptureFromHome() {
  return getSetting('captureFromHome', false);
}

export async function setCaptureFromHome(enabled) {
  await setSetting('captureFromHome', enabled);
}

// --- Starred users ---

export async function getStarredUsers() {
  return getSetting('starredUsers', []);
}

export async function starUser(handle) {
  const starred = await getStarredUsers();
  if (!starred.includes(handle)) {
    starred.push(handle);
    await setSetting('starredUsers', starred);
  }
}

export async function unstarUser(handle) {
  const starred = await getStarredUsers();
  const filtered = starred.filter(h => h !== handle);
  await setSetting('starredUsers', filtered);
}

// --- Tweets ---

export async function storeTweet(tweet) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('tweets', 'readwrite');
    const store = tx.objectStore('tweets');

    const getReq = store.get(tweet.tweetId);
    getReq.onsuccess = () => {
      if (getReq.result) {
        resolve({ inserted: false });
      } else {
        const putReq = store.put(tweet);
        putReq.onsuccess = () => resolve({ inserted: true });
        putReq.onerror = (e) => reject(e.target.error);
      }
    };
    getReq.onerror = (e) => reject(e.target.error);
  });
}

export async function deleteTweet(tweetId) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('tweets', 'readwrite');
    const req = tx.objectStore('tweets').delete(tweetId);
    req.onsuccess = () => resolve();
    req.onerror = (e) => reject(e.target.error);
  });
}

// --- Users ---

// Increment tweet count by delta (use 1 for new tweet, -1 for delete)
export async function adjustUserTweetCount(handle, delta) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('users', 'readwrite');
    const store = tx.objectStore('users');
    const getReq = store.get(handle);

    getReq.onsuccess = () => {
      if (!getReq.result) {
        resolve(null); // User doesn't exist
        return;
      }
      const record = { ...getReq.result };
      record.tweetCount = Math.max(0, (record.tweetCount || 0) + delta);
      const putReq = store.put(record);
      putReq.onsuccess = () => resolve(record);
      putReq.onerror = (e) => reject(e.target.error);
    };
    getReq.onerror = (e) => reject(e.target.error);
  });
}

// Store or update user. If skipCount is true, preserves existing tweetCount (O(1)).
// If skipCount is false or user is new, recounts tweets (O(log n + k)).
export async function storeUser(user, { skipCount = false } = {}) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(['users', 'tweets'], 'readwrite');
    const userStore = tx.objectStore('users');
    const tweetStore = tx.objectStore('tweets');

    const getReq = userStore.get(user.handle);
    getReq.onsuccess = () => {
      const existing = getReq.result || {};
      const isNewUser = !getReq.result;

      // Only count tweets if: new user OR explicitly requested
      if (!skipCount || isNewUser) {
        const index = tweetStore.index('byUser');
        const countReq = index.count(IDBKeyRange.only(user.handle));

        countReq.onsuccess = () => {
          const record = {
            handle: user.handle,
            displayName: user.displayName || existing.displayName || '',
            avatarUrl: user.avatarUrl || existing.avatarUrl || '',
            lastSeen: user.lastSeen || existing.lastSeen,
            tweetCount: countReq.result,
            starred: existing.starred || false,
            notes: existing.notes || ''
          };
          const putReq = userStore.put(record);
          putReq.onsuccess = () => resolve(record);
          putReq.onerror = (e) => reject(e.target.error);
        };
        countReq.onerror = (e) => reject(e.target.error);
      } else {
        // Skip count: just update metadata, preserve existing tweetCount
        const record = {
          handle: user.handle,
          displayName: user.displayName || existing.displayName || '',
          avatarUrl: user.avatarUrl || existing.avatarUrl || '',
          lastSeen: user.lastSeen || existing.lastSeen,
          tweetCount: existing.tweetCount || 0,
          starred: existing.starred || false,
          notes: existing.notes || ''
        };
        const putReq = userStore.put(record);
        putReq.onsuccess = () => resolve(record);
        putReq.onerror = (e) => reject(e.target.error);
      }
    };
    getReq.onerror = (e) => reject(e.target.error);
  });
}

export async function deleteUserAndTweets(handle) {
  const db = await openDB();

  // First, collect all tweet IDs for this user in a read transaction
  const tweetIds = await new Promise((resolve, reject) => {
    const tx = db.transaction('tweets', 'readonly');
    const index = tx.objectStore('tweets').index('byUser');
    const req = index.getAllKeys(IDBKeyRange.only(handle));
    req.onsuccess = () => resolve(req.result);
    req.onerror = (e) => reject(e.target.error);
  });

  // Then delete user + all tweets in a write transaction
  return new Promise((resolve, reject) => {
    const tx = db.transaction(['users', 'tweets'], 'readwrite');
    tx.objectStore('users').delete(handle);
    const tweetStore = tx.objectStore('tweets');
    for (const id of tweetIds) {
      tweetStore.delete(id);
    }
    tx.oncomplete = () => resolve({ deletedTweets: tweetIds.length });
    tx.onerror = (e) => reject(e.target.error);
  });
}

export async function updateUserNotes(handle, notes) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('users', 'readwrite');
    const store = tx.objectStore('users');
    const getReq = store.get(handle);
    getReq.onsuccess = () => {
      if (!getReq.result) { resolve(); return; }
      const record = { ...getReq.result, notes };
      const putReq = store.put(record);
      putReq.onsuccess = () => resolve(record);
      putReq.onerror = (e) => reject(e.target.error);
    };
    getReq.onerror = (e) => reject(e.target.error);
  });
}

export async function setUserStarred(handle, starred) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('users', 'readwrite');
    const store = tx.objectStore('users');
    const getReq = store.get(handle);
    getReq.onsuccess = () => {
      if (!getReq.result) { resolve(); return; }
      const record = { ...getReq.result, starred };
      const putReq = store.put(record);
      putReq.onsuccess = () => resolve(record);
      putReq.onerror = (e) => reject(e.target.error);
    };
    getReq.onerror = (e) => reject(e.target.error);
  });
}

export async function getAllUsers() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('users', 'readonly');
    const store = tx.objectStore('users');

    // Try to use index for sorted retrieval (starred desc, tweetCount desc)
    // Index key: [starred (boolean), tweetCount (number)]
    // 'prev' direction gives us: true before false, high numbers before low
    if (store.indexNames.contains('bySortOrder')) {
      const index = store.index('bySortOrder');
      const results = [];
      const req = index.openCursor(null, 'prev');

      req.onsuccess = (event) => {
        const cursor = event.target.result;
        if (cursor) {
          results.push(cursor.value);
          cursor.continue();
        } else {
          resolve(results);
        }
      };
      req.onerror = (e) => reject(e.target.error);
    } else {
      // Fallback: load all and sort in memory (for upgrades in progress)
      const req = store.getAll();
      req.onsuccess = () => {
        const users = req.result.sort((a, b) => {
          if (a.starred && !b.starred) return -1;
          if (!a.starred && b.starred) return 1;
          return (b.tweetCount || 0) - (a.tweetCount || 0);
        });
        resolve(users);
      };
      req.onerror = (e) => reject(e.target.error);
    }
  });
}

export async function getUser(handle) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('users', 'readonly');
    const req = tx.objectStore('users').get(handle);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = (e) => reject(e.target.error);
  });
}

export async function getTweetsByUser(handle, { limit = 50, offset = 0 } = {}) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('tweets', 'readonly');
    const store = tx.objectStore('tweets');
    const index = store.index('byUserAndTime');

    const range = IDBKeyRange.bound(
      [handle, ''],
      [handle, '\uffff']
    );

    const results = [];
    let skipped = 0;
    const req = index.openCursor(range, 'prev');

    req.onsuccess = (event) => {
      const cursor = event.target.result;
      if (!cursor || results.length >= limit) {
        resolve(results);
        return;
      }
      if (skipped < offset) {
        skipped++;
        cursor.continue();
        return;
      }
      results.push(cursor.value);
      cursor.continue();
    };
    req.onerror = (e) => reject(e.target.error);
  });
}

export async function searchTweets(query, { limit = 100 } = {}) {
  const db = await openDB();
  const lowerQuery = query.toLowerCase();

  return new Promise((resolve, reject) => {
    const tx = db.transaction('tweets', 'readonly');
    const store = tx.objectStore('tweets');
    const results = [];
    const req = store.openCursor();

    req.onsuccess = (event) => {
      const cursor = event.target.result;
      if (!cursor || results.length >= limit) {
        resolve(results);
        return;
      }
      const tweet = cursor.value;
      if (
        tweet.fullText.toLowerCase().includes(lowerQuery) ||
        tweet.handle.toLowerCase().includes(lowerQuery) ||
        tweet.displayName.toLowerCase().includes(lowerQuery)
      ) {
        results.push(tweet);
      }
      cursor.continue();
    };
    req.onerror = (e) => reject(e.target.error);
  });
}

export async function getTweetCount() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('tweets', 'readonly');
    const store = tx.objectStore('tweets');
    const req = store.count();
    req.onsuccess = () => resolve(req.result);
    req.onerror = (e) => reject(e.target.error);
  });
}

export async function getAllTweetsForUser(handle) {
  return getTweetsByUser(handle, { limit: Infinity, offset: 0 });
}
