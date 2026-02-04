const DB_NAME = 'TwitterScrapeDB';
const DB_VERSION = 7;

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

      // V5: Add inverted index for fast text search
      // Structure: { word: string, tweetIds: string[] }
      if (!db.objectStoreNames.contains('searchIndex')) {
        db.createObjectStore('searchIndex', { keyPath: 'word' });
      }

      // V6: Add index for fetching recently captured tweets
      if (event.oldVersion < 6) {
        const tweetStore = db.objectStoreNames.contains('tweets')
          ? tx.objectStore('tweets')
          : null;
        if (tweetStore && !tweetStore.indexNames.contains('byCapturedAt')) {
          tweetStore.createIndex('byCapturedAt', 'capturedAt', { unique: false });
        }
      }

      // V7: Add blogPosts object store for user blog posts
      if (!db.objectStoreNames.contains('blogPosts')) {
        const blogStore = db.createObjectStore('blogPosts', { keyPath: 'postId' });
        blogStore.createIndex('byUser', 'handle', { unique: false });
        blogStore.createIndex('byUserAndTime', ['handle', 'createdAt'], { unique: false });
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

// --- Home Feed Settings ---

const DEFAULT_HOME_FEED_SETTINGS = {
  enabled: false,
  minLikes: 0,
  minImpressions: 0
};

export async function getHomeFeedSettings() {
  return getSetting('homeFeedSettings', DEFAULT_HOME_FEED_SETTINGS);
}

export async function setHomeFeedSettings(settings) {
  await setSetting('homeFeedSettings', {
    ...DEFAULT_HOME_FEED_SETTINGS,
    ...settings
  });
}

// Legacy compatibility
export async function getCaptureFromHome() {
  const settings = await getHomeFeedSettings();
  return settings.enabled;
}

export async function setCaptureFromHome(enabled) {
  const current = await getHomeFeedSettings();
  await setHomeFeedSettings({ ...current, enabled });
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

// --- Search Index Helpers ---

// Tokenize text into searchable words (lowercase, min 2 chars)
function tokenizeText(text) {
  if (!text) return [];
  return text
    .toLowerCase()
    .replace(/[^\w\s@]/g, ' ')  // Replace punctuation with spaces
    .split(/\s+/)
    .filter(word => word.length >= 2)  // Min 2 chars
    .filter((word, i, arr) => arr.indexOf(word) === i);  // Unique
}

// Add tweetId to search index for given words
async function indexTweetWords(db, tweetId, words) {
  if (words.length === 0) return;

  return new Promise((resolve, reject) => {
    const tx = db.transaction('searchIndex', 'readwrite');
    const store = tx.objectStore('searchIndex');
    let pending = words.length;

    for (const word of words) {
      const getReq = store.get(word);
      getReq.onsuccess = () => {
        const existing = getReq.result || { word, tweetIds: [] };
        if (!existing.tweetIds.includes(tweetId)) {
          existing.tweetIds.push(tweetId);
          store.put(existing);
        }
        pending--;
        if (pending === 0) resolve();
      };
      getReq.onerror = (e) => reject(e.target.error);
    }

    tx.onerror = (e) => reject(e.target.error);
  });
}

// Remove tweetId from search index for given words
async function unindexTweetWords(db, tweetId, words) {
  if (words.length === 0) return;

  return new Promise((resolve, reject) => {
    const tx = db.transaction('searchIndex', 'readwrite');
    const store = tx.objectStore('searchIndex');
    let pending = words.length;

    for (const word of words) {
      const getReq = store.get(word);
      getReq.onsuccess = () => {
        const existing = getReq.result;
        if (existing) {
          existing.tweetIds = existing.tweetIds.filter(id => id !== tweetId);
          if (existing.tweetIds.length === 0) {
            store.delete(word);
          } else {
            store.put(existing);
          }
        }
        pending--;
        if (pending === 0) resolve();
      };
      getReq.onerror = (e) => reject(e.target.error);
    }

    tx.onerror = (e) => reject(e.target.error);
  });
}

// --- Tweets ---

export async function storeTweet(tweet) {
  const db = await openDB();

  // Check if already exists
  const existing = await new Promise((resolve, reject) => {
    const tx = db.transaction('tweets', 'readonly');
    const req = tx.objectStore('tweets').get(tweet.tweetId);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = (e) => reject(e.target.error);
  });

  if (existing) {
    // Update if existing record is missing text or engagement metrics
    const needsUpdate = (!existing.fullText && tweet.fullText) ||
      (!existing.viewCount && tweet.viewCount) ||
      (!existing.retweetCount && tweet.retweetCount) ||
      (!existing.replyCount && tweet.replyCount) ||
      (!existing.bookmarkCount && tweet.bookmarkCount);

    if (needsUpdate) {
      const merged = { ...existing, ...tweet, capturedAt: existing.capturedAt };
      // Keep existing non-empty text
      if (existing.fullText) merged.fullText = existing.fullText;
      await new Promise((resolve, reject) => {
        const tx = db.transaction('tweets', 'readwrite');
        const req = tx.objectStore('tweets').put(merged);
        req.onsuccess = () => resolve();
        req.onerror = (e) => reject(e.target.error);
      });
      // Re-index if text was added
      if (!existing.fullText && tweet.fullText) {
        try {
          if (db.objectStoreNames.contains('searchIndex')) {
            const words = tokenizeText(`${merged.fullText} ${merged.handle} ${merged.displayName}`);
            await indexTweetWords(db, merged.tweetId, words);
          }
        } catch (e) {
          console.warn('[X-Vault] Search indexing failed (non-critical):', e);
        }
      }
      return { inserted: false, updated: true };
    }
    return { inserted: false };
  }

  // Store the tweet
  await new Promise((resolve, reject) => {
    const tx = db.transaction('tweets', 'readwrite');
    const req = tx.objectStore('tweets').put(tweet);
    req.onsuccess = () => resolve();
    req.onerror = (e) => reject(e.target.error);
  });

  // Index the tweet text for search (non-blocking - don't fail if indexing fails)
  try {
    if (db.objectStoreNames.contains('searchIndex')) {
      const words = tokenizeText(`${tweet.fullText} ${tweet.handle} ${tweet.displayName}`);
      await indexTweetWords(db, tweet.tweetId, words);
    }
  } catch (e) {
    console.warn('[X-Vault] Search indexing failed (non-critical):', e);
  }

  return { inserted: true };
}

export async function deleteTweet(tweetId) {
  const db = await openDB();

  // Get the tweet first to extract words for unindexing
  const tweet = await new Promise((resolve, reject) => {
    const tx = db.transaction('tweets', 'readonly');
    const req = tx.objectStore('tweets').get(tweetId);
    req.onsuccess = () => resolve(req.result);
    req.onerror = (e) => reject(e.target.error);
  });

  // Delete the tweet
  await new Promise((resolve, reject) => {
    const tx = db.transaction('tweets', 'readwrite');
    const req = tx.objectStore('tweets').delete(tweetId);
    req.onsuccess = () => resolve();
    req.onerror = (e) => reject(e.target.error);
  });

  // Remove from search index (non-blocking)
  try {
    if (tweet && db.objectStoreNames.contains('searchIndex')) {
      const words = tokenizeText(`${tweet.fullText} ${tweet.handle} ${tweet.displayName}`);
      await unindexTweetWords(db, tweetId, words);
    }
  } catch (e) {
    console.warn('[X-Vault] Search unindexing failed (non-critical):', e);
  }
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

  // Collect all blog post IDs for this user
  const postIds = await new Promise((resolve, reject) => {
    if (!db.objectStoreNames.contains('blogPosts')) {
      resolve([]);
      return;
    }
    const tx = db.transaction('blogPosts', 'readonly');
    const index = tx.objectStore('blogPosts').index('byUser');
    const req = index.getAllKeys(IDBKeyRange.only(handle));
    req.onsuccess = () => resolve(req.result);
    req.onerror = (e) => reject(e.target.error);
  });

  // Then delete user + all tweets + all blog posts in a write transaction
  const stores = ['users', 'tweets'];
  if (db.objectStoreNames.contains('blogPosts')) {
    stores.push('blogPosts');
  }

  return new Promise((resolve, reject) => {
    const tx = db.transaction(stores, 'readwrite');
    tx.objectStore('users').delete(handle);
    const tweetStore = tx.objectStore('tweets');
    for (const id of tweetIds) {
      tweetStore.delete(id);
    }
    if (db.objectStoreNames.contains('blogPosts')) {
      const postStore = tx.objectStore('blogPosts');
      for (const id of postIds) {
        postStore.delete(id);
      }
    }
    tx.oncomplete = () => resolve({ deletedTweets: tweetIds.length, deletedPosts: postIds.length });
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

    // Use getAll with in-memory sort for reliability
    // (existing records may not have all indexed fields populated)
    const req = store.getAll();
    req.onsuccess = () => {
      const users = req.result.sort((a, b) => {
        // Starred first, then by tweet count
        if (a.starred && !b.starred) return -1;
        if (!a.starred && b.starred) return 1;
        return (b.tweetCount || 0) - (a.tweetCount || 0);
      });
      resolve(users);
    };
    req.onerror = (e) => reject(e.target.error);
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
  const lowerQuery = query.toLowerCase().trim();

  // Tokenize query to find whole word matches via index
  const queryTokens = tokenizeText(lowerQuery);

  // If we have tokens, try fast index lookup first
  if (queryTokens.length > 0 && db.objectStoreNames.contains('searchIndex')) {
    try {
      // Get tweetIds for each token
      const tokenResults = await Promise.all(
        queryTokens.map(token => new Promise((resolve, reject) => {
          const tx = db.transaction('searchIndex', 'readonly');
          const req = tx.objectStore('searchIndex').get(token);
          req.onsuccess = () => resolve(req.result?.tweetIds || []);
          req.onerror = (e) => reject(e.target.error);
        }))
      );

      // Intersect results - tweet must contain ALL query tokens
      let matchingIds = tokenResults[0] || [];
      for (let i = 1; i < tokenResults.length; i++) {
        const nextIds = new Set(tokenResults[i]);
        matchingIds = matchingIds.filter(id => nextIds.has(id));
      }

      // Limit and fetch actual tweets
      const limitedIds = matchingIds.slice(0, limit);
      if (limitedIds.length > 0) {
        const tweets = await Promise.all(
          limitedIds.map(tweetId => new Promise((resolve, reject) => {
            const tx = db.transaction('tweets', 'readonly');
            const req = tx.objectStore('tweets').get(tweetId);
            req.onsuccess = () => resolve(req.result);
            req.onerror = (e) => reject(e.target.error);
          }))
        );
        // Filter out any null results (deleted tweets not yet cleaned from index)
        return tweets.filter(Boolean);
      }

      // No index matches - could be partial word, fall through to scan
    } catch (e) {
      console.warn('[X-Vault] Index search failed, falling back to scan:', e);
    }
  }

  // Fallback: full scan for partial matches or when index unavailable
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

export async function getRecentTweets({ limit = 50 } = {}) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('tweets', 'readonly');
    const store = tx.objectStore('tweets');

    // Use byCapturedAt index if available, otherwise fall back to full scan
    if (store.indexNames.contains('byCapturedAt')) {
      const index = store.index('byCapturedAt');
      const results = [];
      const req = index.openCursor(null, 'prev');

      req.onsuccess = (event) => {
        const cursor = event.target.result;
        if (!cursor || results.length >= limit) {
          resolve(results);
          return;
        }
        results.push(cursor.value);
        cursor.continue();
      };
      req.onerror = (e) => reject(e.target.error);
    } else {
      // Fallback: get all and sort in memory
      const req = store.getAll();
      req.onsuccess = () => {
        const tweets = req.result
          .sort((a, b) => (b.capturedAt || '').localeCompare(a.capturedAt || ''))
          .slice(0, limit);
        resolve(tweets);
      };
      req.onerror = (e) => reject(e.target.error);
    }
  });
}

export async function getAllTweetsForUser(handle) {
  return getTweetsByUser(handle, { limit: Infinity, offset: 0 });
}

// --- Blog Posts ---

// Generate unique post ID
function generatePostId() {
  return `post_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

export async function storeBlogPost(post) {
  const db = await openDB();
  const now = new Date().toISOString();

  const record = {
    postId: post.postId || generatePostId(),
    handle: post.handle,
    title: post.title || '',
    content: post.content || '',
    createdAt: post.createdAt || now,
    updatedAt: now
  };

  return new Promise((resolve, reject) => {
    const tx = db.transaction('blogPosts', 'readwrite');
    const store = tx.objectStore('blogPosts');
    const req = store.put(record);
    req.onsuccess = () => resolve(record);
    req.onerror = (e) => reject(e.target.error);
  });
}

export async function getBlogPostsByUser(handle) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('blogPosts', 'readonly');
    const store = tx.objectStore('blogPosts');
    const index = store.index('byUserAndTime');

    const range = IDBKeyRange.bound(
      [handle, ''],
      [handle, '\uffff']
    );

    const results = [];
    const req = index.openCursor(range, 'prev'); // newest first

    req.onsuccess = (event) => {
      const cursor = event.target.result;
      if (!cursor) {
        resolve(results);
        return;
      }
      results.push(cursor.value);
      cursor.continue();
    };
    req.onerror = (e) => reject(e.target.error);
  });
}

export async function getBlogPost(postId) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('blogPosts', 'readonly');
    const req = tx.objectStore('blogPosts').get(postId);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = (e) => reject(e.target.error);
  });
}

export async function updateBlogPost(postId, updates) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('blogPosts', 'readwrite');
    const store = tx.objectStore('blogPosts');
    const getReq = store.get(postId);

    getReq.onsuccess = () => {
      if (!getReq.result) {
        resolve(null);
        return;
      }
      const record = {
        ...getReq.result,
        ...updates,
        postId, // ensure postId is not overwritten
        updatedAt: new Date().toISOString()
      };
      const putReq = store.put(record);
      putReq.onsuccess = () => resolve(record);
      putReq.onerror = (e) => reject(e.target.error);
    };
    getReq.onerror = (e) => reject(e.target.error);
  });
}

export async function deleteBlogPost(postId) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('blogPosts', 'readwrite');
    const req = tx.objectStore('blogPosts').delete(postId);
    req.onsuccess = () => resolve({ deleted: true });
    req.onerror = (e) => reject(e.target.error);
  });
}

export async function deleteBlogPostsByUser(handle) {
  const db = await openDB();

  // First get all post IDs for this user
  const postIds = await new Promise((resolve, reject) => {
    const tx = db.transaction('blogPosts', 'readonly');
    const index = tx.objectStore('blogPosts').index('byUser');
    const req = index.getAllKeys(IDBKeyRange.only(handle));
    req.onsuccess = () => resolve(req.result);
    req.onerror = (e) => reject(e.target.error);
  });

  // Delete all posts
  return new Promise((resolve, reject) => {
    const tx = db.transaction('blogPosts', 'readwrite');
    const store = tx.objectStore('blogPosts');
    for (const id of postIds) {
      store.delete(id);
    }
    tx.oncomplete = () => resolve({ deletedPosts: postIds.length });
    tx.onerror = (e) => reject(e.target.error);
  });
}

// --- Full Database Export/Import ---

export async function exportAllData() {
  const db = await openDB();

  // Get all tweets
  const tweets = await new Promise((resolve, reject) => {
    const tx = db.transaction('tweets', 'readonly');
    const req = tx.objectStore('tweets').getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = (e) => reject(e.target.error);
  });

  // Get all users
  const users = await new Promise((resolve, reject) => {
    const tx = db.transaction('users', 'readonly');
    const req = tx.objectStore('users').getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = (e) => reject(e.target.error);
  });

  // Get all blocked users
  const blockedUsers = await new Promise((resolve, reject) => {
    const tx = db.transaction('blockedUsers', 'readonly');
    const req = tx.objectStore('blockedUsers').getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = (e) => reject(e.target.error);
  });

  // Get all settings
  const settings = await new Promise((resolve, reject) => {
    const tx = db.transaction('settings', 'readonly');
    const req = tx.objectStore('settings').getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = (e) => reject(e.target.error);
  });

  // Get all blog posts
  const blogPosts = await new Promise((resolve, reject) => {
    if (!db.objectStoreNames.contains('blogPosts')) {
      resolve([]);
      return;
    }
    const tx = db.transaction('blogPosts', 'readonly');
    const req = tx.objectStore('blogPosts').getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = (e) => reject(e.target.error);
  });

  return {
    version: DB_VERSION,
    exportedAt: new Date().toISOString(),
    tweets,
    users,
    blockedUsers,
    settings,
    blogPosts
  };
}

export async function importAllData(data, { merge = true } = {}) {
  const db = await openDB();

  // Validate data structure
  if (!data || typeof data !== 'object') {
    throw new Error('Invalid data format');
  }

  const tweets = data.tweets || [];
  const users = data.users || [];
  const blockedUsers = data.blockedUsers || [];
  const settings = data.settings || [];
  const blogPosts = data.blogPosts || [];

  const stores = ['tweets', 'users', 'blockedUsers', 'settings'];
  if (db.objectStoreNames.contains('blogPosts')) {
    stores.push('blogPosts');
  }

  return new Promise((resolve, reject) => {
    const tx = db.transaction(stores, 'readwrite');
    const tweetStore = tx.objectStore('tweets');
    const userStore = tx.objectStore('users');
    const blockedStore = tx.objectStore('blockedUsers');
    const settingsStore = tx.objectStore('settings');
    const blogStore = db.objectStoreNames.contains('blogPosts') ? tx.objectStore('blogPosts') : null;

    let importedTweets = 0;
    let importedUsers = 0;
    let importedBlocked = 0;
    let importedSettings = 0;
    let importedBlogPosts = 0;

    // Clear existing data if not merging
    if (!merge) {
      tweetStore.clear();
      userStore.clear();
      blockedStore.clear();
      settingsStore.clear();
      if (blogStore) blogStore.clear();
    }

    // Import tweets
    for (const tweet of tweets) {
      if (merge) {
        // Only add if doesn't exist
        const getReq = tweetStore.get(tweet.tweetId);
        getReq.onsuccess = () => {
          if (!getReq.result) {
            tweetStore.put(tweet);
            importedTweets++;
          }
        };
      } else {
        tweetStore.put(tweet);
        importedTweets++;
      }
    }

    // Import users
    for (const user of users) {
      if (merge) {
        const getReq = userStore.get(user.handle);
        getReq.onsuccess = () => {
          if (!getReq.result) {
            userStore.put(user);
            importedUsers++;
          } else {
            // Merge: keep higher tweet count, update other fields
            const existing = getReq.result;
            const merged = {
              ...existing,
              displayName: user.displayName || existing.displayName,
              avatarUrl: user.avatarUrl || existing.avatarUrl,
              tweetCount: Math.max(existing.tweetCount || 0, user.tweetCount || 0),
              starred: existing.starred || user.starred,
              notes: existing.notes || user.notes
            };
            userStore.put(merged);
          }
        };
      } else {
        userStore.put(user);
        importedUsers++;
      }
    }

    // Import blocked users
    for (const blocked of blockedUsers) {
      if (merge) {
        const getReq = blockedStore.get(blocked.handle);
        getReq.onsuccess = () => {
          if (!getReq.result) {
            blockedStore.put(blocked);
            importedBlocked++;
          }
        };
      } else {
        blockedStore.put(blocked);
        importedBlocked++;
      }
    }

    // Import settings
    for (const setting of settings) {
      if (merge) {
        const getReq = settingsStore.get(setting.key);
        getReq.onsuccess = () => {
          if (!getReq.result) {
            settingsStore.put(setting);
            importedSettings++;
          }
        };
      } else {
        settingsStore.put(setting);
        importedSettings++;
      }
    }

    // Import blog posts
    if (blogStore && blogPosts.length > 0) {
      for (const post of blogPosts) {
        if (merge) {
          const getReq = blogStore.get(post.postId);
          getReq.onsuccess = () => {
            if (!getReq.result) {
              blogStore.put(post);
              importedBlogPosts++;
            }
          };
        } else {
          blogStore.put(post);
          importedBlogPosts++;
        }
      }
    }

    tx.oncomplete = () => resolve({
      tweets: merge ? importedTweets : tweets.length,
      users: merge ? importedUsers : users.length,
      blockedUsers: merge ? importedBlocked : blockedUsers.length,
      settings: merge ? importedSettings : settings.length,
      blogPosts: merge ? importedBlogPosts : blogPosts.length
    });
    tx.onerror = (e) => reject(e.target.error);
  });
}
