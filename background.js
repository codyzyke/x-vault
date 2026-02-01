console.log('[X-Vault] Background service worker loaded at', new Date().toISOString());

import {
  storeTweet,
  storeUser,
  adjustUserTweetCount,
  getAllUsers,
  getUser,
  getTweetsByUser,
  searchTweets,
  getTweetCount,
  getAllTweetsForUser,
  deleteUserAndTweets,
  deleteTweet,
  blockUser,
  unblockUser,
  getBlockedUsers,
  isBlocked,
  getCaptureFromHome,
  setCaptureFromHome,
  setUserStarred,
  updateUserNotes
} from './db.js';

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message).then(sendResponse).catch((err) => {
    console.error('[X-Vault] Error handling message:', message.type, err);
    sendResponse({ error: err.message });
  });
  return true;
});

async function handleMessage(message) {
  switch (message.type) {
    case 'STORE_TWEET': {
      // Check if user is blocked before storing
      if (await isBlocked(message.tweet.handle)) {
        return { inserted: false, blocked: true };
      }

      const result = await storeTweet(message.tweet);
      if (result.inserted) {
        // Store user metadata (skipCount=true) then increment count O(1)
        await storeUser({
          handle: message.tweet.handle,
          displayName: message.tweet.displayName,
          avatarUrl: message.tweet.avatarUrl,
          lastSeen: new Date().toISOString()
        }, { skipCount: true });
        const user = await adjustUserTweetCount(message.tweet.handle, 1);
        const count = await getTweetCount();
        chrome.action.setBadgeText({ text: String(count) });
        chrome.action.setBadgeBackgroundColor({ color: '#1DA1F2' });

        chrome.runtime.sendMessage({
          type: 'TWEET_ADDED',
          tweet: message.tweet,
          totalCount: count,
          user
        }).catch(() => { });
      }
      return result;
    }

    case 'GET_USERS':
      return await getAllUsers();

    case 'GET_USER':
      return await getUser(message.handle);

    case 'GET_TWEETS_BY_USER':
      return await getTweetsByUser(message.handle, {
        limit: message.limit || 50,
        offset: message.offset || 0
      });

    case 'SEARCH_TWEETS':
      return await searchTweets(message.query, {
        limit: message.limit || 100
      });

    case 'GET_TWEET_COUNT':
      return await getTweetCount();

    case 'GET_ALL_TWEETS_FOR_USER':
      return await getAllTweetsForUser(message.handle);

    case 'DELETE_USER': {
      console.log('[X-Vault] DELETE_USER called for:', message.handle);
      try {
        await deleteUserAndTweets(message.handle);
        const count = await getTweetCount();
        chrome.action.setBadgeText({ text: count > 0 ? String(count) : '' });
        console.log('[X-Vault] DELETE_USER success, remaining tweets:', count);
        return { deleted: true, totalCount: count };
      } catch (err) {
        console.error('[X-Vault] DELETE_USER failed:', err);
        return { error: err.message, deleted: false };
      }
    }

    case 'DELETE_TWEET': {
      await deleteTweet(message.tweetId);
      // Decrement the user's tweet count O(1)
      if (message.handle) {
        await adjustUserTweetCount(message.handle, -1);
      }
      const count = await getTweetCount();
      chrome.action.setBadgeText({ text: count > 0 ? String(count) : '' });
      return { deleted: true, totalCount: count };
    }

    case 'BLOCK_USER': {
      await blockUser(message.handle);
      // Also delete existing data for this user
      await deleteUserAndTweets(message.handle);
      const count = await getTweetCount();
      chrome.action.setBadgeText({ text: count > 0 ? String(count) : '' });
      return { blocked: true, totalCount: count };
    }

    case 'UNBLOCK_USER':
      await unblockUser(message.handle);
      return { unblocked: true };

    case 'GET_BLOCKED_USERS':
      return await getBlockedUsers();

    case 'STAR_USER':
      await setUserStarred(message.handle, true);
      return { starred: true };

    case 'UNSTAR_USER':
      await setUserStarred(message.handle, false);
      return { unstarred: true };

    case 'UPDATE_USER_NOTES':
      return await updateUserNotes(message.handle, message.notes);

    case 'OPEN_POPUP': {
      // Open the dashboard in a new tab
      chrome.tabs.create({ url: chrome.runtime.getURL('dashboard.html') });
      return { opened: true };
    }

    case 'GET_CAPTURE_FROM_HOME':
      return await getCaptureFromHome();

    case 'SET_CAPTURE_FROM_HOME':
      await setCaptureFromHome(message.enabled);
      return { success: true };

    default:
      console.error('[X-Vault] Unknown message type received:', message.type, message);
      return { error: 'Unknown message type' };
  }
}
