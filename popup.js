let currentTweets = [];
let selectedUser = null;

function sendMessage(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, resolve);
  });
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function formatTimestamp(iso) {
  if (!iso) return '';
  const date = new Date(iso);
  const now = new Date();
  const diffMs = now - date;
  const diffMin = Math.floor(diffMs / 60000);

  if (diffMin < 1) return 'now';
  if (diffMin < 60) return `${diffMin}m`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 7) return `${diffDay}d`;

  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: date.getFullYear() !== now.getFullYear() ? 'numeric' : undefined });
}

function showToast(msg) {
  const toast = document.getElementById('toast');
  toast.textContent = msg;
  toast.classList.remove('hidden');
  setTimeout(() => toast.classList.add('hidden'), 2000);
}

function renderUserList(users) {
  const container = document.getElementById('user-list');
  container.innerHTML = '';

  for (const user of users) {
    const el = document.createElement('div');
    el.className = 'user-item';
    el.dataset.handle = user.handle;
    if (selectedUser === user.handle) el.classList.add('active');

    const name = document.createElement('span');
    name.textContent = `@${user.handle}`;
    el.appendChild(name);

    const badge = document.createElement('span');
    badge.className = 'count-badge';
    badge.textContent = user.tweetCount || 0;
    el.appendChild(badge);

    el.addEventListener('click', () => selectUser(user.handle));
    container.appendChild(el);
  }
}

function renderTweetList(tweets) {
  currentTweets = tweets;
  const container = document.getElementById('tweet-list');
  container.innerHTML = '';

  if (tweets.length === 0) {
    container.innerHTML = '<div id="empty-state">No tweets found.</div>';
    return;
  }

  for (const tweet of tweets) {
    const card = document.createElement('div');
    card.className = 'tweet-card';
    card.dataset.tweetId = tweet.tweetId;

    let retweetHtml = '';
    if (tweet.isRetweet && tweet.retweetedBy) {
      retweetHtml = `<div class="retweet-badge">Reposted by @${escapeHtml(tweet.retweetedBy)}</div>`;
    }

    card.innerHTML = `
      <label class="tweet-select">
        <input type="checkbox" class="tweet-checkbox" value="${escapeHtml(tweet.tweetId)}">
      </label>
      <div class="tweet-content">
        ${retweetHtml}
        <div class="tweet-header">
          <strong>${escapeHtml(tweet.displayName)}</strong>
          <span class="handle">@${escapeHtml(tweet.handle)}</span>
          <span class="timestamp">${formatTimestamp(tweet.timestamp)}</span>
          <a href="${escapeHtml(tweet.url)}" target="_blank" class="tweet-link" title="Open on X">↗</a>
        </div>
        <div class="tweet-text">${escapeHtml(tweet.fullText)}</div>
      </div>
    `;

    const checkbox = card.querySelector('.tweet-checkbox');
    checkbox.addEventListener('change', () => {
      card.classList.toggle('selected', checkbox.checked);
    });

    container.appendChild(card);
  }
}

async function selectUser(handle) {
  selectedUser = handle;

  // Update active state in user list
  document.querySelectorAll('.user-item').forEach((el) => {
    el.classList.toggle('active', el.querySelector('span').textContent === `@${handle}`);
  });

  const tweets = await sendMessage({
    type: 'GET_TWEETS_BY_USER',
    handle,
    limit: 200
  });
  renderTweetList(tweets || []);
}

function getSelectedTweetIds() {
  return Array.from(document.querySelectorAll('.tweet-checkbox:checked')).map(cb => cb.value);
}

function formatTweets(tweets, format) {
  switch (format) {
    case 'markdown':
      return tweets.map(t =>
        `### @${t.handle} - ${t.displayName}\n` +
        `**${new Date(t.timestamp).toLocaleString()}** | [Link](${t.url})\n\n` +
        `${t.fullText}\n\n---`
      ).join('\n\n');

    case 'json':
      return JSON.stringify(tweets.map(t => ({
        handle: t.handle,
        displayName: t.displayName,
        timestamp: t.timestamp,
        text: t.fullText,
        url: t.url
      })), null, 2);

    case 'text':
      return tweets.map(t =>
        `@${t.handle} (${new Date(t.timestamp).toLocaleString()}):\n` +
        `${t.fullText}\n${t.url}\n---`
      ).join('\n\n');

    default:
      return '';
  }
}

// Search
let searchDebounce;
document.getElementById('search-input').addEventListener('input', (e) => {
  clearTimeout(searchDebounce);
  searchDebounce = setTimeout(async () => {
    const query = e.target.value.trim();
    if (query.length < 2) {
      // Restore user view
      if (selectedUser) {
        selectUser(selectedUser);
      }
      return;
    }
    const results = await sendMessage({ type: 'SEARCH_TWEETS', query, limit: 200 });
    renderTweetList(results || []);
  }, 300);
});

// Export selected
document.getElementById('export-selected').addEventListener('click', async () => {
  const ids = getSelectedTweetIds();
  if (ids.length === 0) {
    showToast('No tweets selected');
    return;
  }
  const tweets = currentTweets.filter(t => ids.includes(t.tweetId));
  const format = document.getElementById('export-format').value;
  await navigator.clipboard.writeText(formatTweets(tweets, format));
  showToast(`Copied ${tweets.length} tweet${tweets.length > 1 ? 's' : ''}`);
});

// Copy all visible
document.getElementById('copy-all').addEventListener('click', async () => {
  if (currentTweets.length === 0) {
    showToast('No tweets to copy');
    return;
  }
  const format = document.getElementById('export-format').value;
  await navigator.clipboard.writeText(formatTweets(currentTweets, format));
  showToast(`Copied ${currentTweets.length} tweet${currentTweets.length > 1 ? 's' : ''}`);
});

// Listen for real-time updates from background worker
chrome.runtime.onMessage.addListener((message) => {
  if (message.type !== 'TWEET_ADDED') return;

  // Update total count
  document.getElementById('tweet-count').textContent = `${message.totalCount} tweets`;

  // Update user list: refresh counts and add new users
  refreshUserList(message.user);

  // If we're viewing the user whose tweet just arrived, append it live
  if (selectedUser === message.tweet.handle) {
    appendTweet(message.tweet);
  }
});

function refreshUserList(updatedUser) {
  const container = document.getElementById('user-list');
  const existing = container.querySelector(`[data-handle="${updatedUser.handle}"]`);

  if (existing) {
    // Update count badge
    existing.querySelector('.count-badge').textContent = updatedUser.tweetCount || 0;
  } else {
    // New user — add to the list
    const el = document.createElement('div');
    el.className = 'user-item';
    el.dataset.handle = updatedUser.handle;

    const name = document.createElement('span');
    name.textContent = `@${updatedUser.handle}`;
    el.appendChild(name);

    const badge = document.createElement('span');
    badge.className = 'count-badge';
    badge.textContent = updatedUser.tweetCount || 0;
    el.appendChild(badge);

    el.addEventListener('click', () => selectUser(updatedUser.handle));
    container.appendChild(el);
  }
}

function appendTweet(tweet) {
  // Skip if already rendered
  if (currentTweets.some(t => t.tweetId === tweet.tweetId)) return;

  currentTweets.unshift(tweet);

  const container = document.getElementById('tweet-list');
  // Remove empty state if present
  const empty = container.querySelector('#empty-state');
  if (empty) empty.remove();

  const card = document.createElement('div');
  card.className = 'tweet-card';
  card.dataset.tweetId = tweet.tweetId;

  let retweetHtml = '';
  if (tweet.isRetweet && tweet.retweetedBy) {
    retweetHtml = `<div class="retweet-badge">Reposted by @${escapeHtml(tweet.retweetedBy)}</div>`;
  }

  card.innerHTML = `
    <label class="tweet-select">
      <input type="checkbox" class="tweet-checkbox" value="${escapeHtml(tweet.tweetId)}">
    </label>
    <div class="tweet-content">
      ${retweetHtml}
      <div class="tweet-header">
        <strong>${escapeHtml(tweet.displayName)}</strong>
        <span class="handle">@${escapeHtml(tweet.handle)}</span>
        <span class="timestamp">${formatTimestamp(tweet.timestamp)}</span>
        <a href="${escapeHtml(tweet.url)}" target="_blank" class="tweet-link" title="Open on X">↗</a>
      </div>
      <div class="tweet-text">${escapeHtml(tweet.fullText)}</div>
    </div>
  `;

  const checkbox = card.querySelector('.tweet-checkbox');
  checkbox.addEventListener('change', () => {
    card.classList.toggle('selected', checkbox.checked);
  });

  container.prepend(card);
}

// Open dashboard
document.getElementById('open-dashboard').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('dashboard.html') });
  window.close();
});

// Init
document.addEventListener('DOMContentLoaded', async () => {
  const count = await sendMessage({ type: 'GET_TWEET_COUNT' });
  document.getElementById('tweet-count').textContent = `${count || 0} tweets`;

  // Load capture from home setting
  const captureHomeToggle = document.getElementById('capture-home-toggle');
  const captureFromHome = await sendMessage({ type: 'GET_CAPTURE_FROM_HOME' });
  captureHomeToggle.checked = captureFromHome || false;

  captureHomeToggle.addEventListener('change', async () => {
    await sendMessage({ type: 'SET_CAPTURE_FROM_HOME', enabled: captureHomeToggle.checked });
  });

  const users = await sendMessage({ type: 'GET_USERS' });
  if (users && users.length > 0) {
    renderUserList(users);
    selectUser(users[0].handle);
  }
});
