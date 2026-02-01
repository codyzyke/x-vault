let currentTweets = [];
let selectedUser = null;
let selectedUserData = null;
let allSelectMode = false;
let notesDebounce = null;

let toastTimer = null;

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

  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 7) return `${diffDay}d ago`;

  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: date.getFullYear() !== now.getFullYear() ? 'numeric' : undefined
  });
}

function formatDate(iso) {
  if (!iso) return '?';
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

// ==================== Toast with Undo ====================

function showToast(msg) {
  clearTimeout(toastTimer);
  const toast = document.getElementById('toast');
  const msgEl = document.getElementById('toast-msg');
  msgEl.textContent = msg;
  toast.classList.remove('hidden');
  toastTimer = setTimeout(() => toast.classList.add('hidden'), 2000);
}

// ==================== User Sidebar ====================

function renderUserList(users) {
  const container = document.getElementById('user-list');
  container.innerHTML = '';

  for (const user of users) {
    container.appendChild(createUserItem(user));
  }
}

function createUserItem(user) {
  const el = document.createElement('div');
  el.className = 'user-item';
  el.dataset.handle = user.handle;
  if (selectedUser === user.handle) el.classList.add('active');

  // Avatar
  const avatar = document.createElement('div');
  avatar.className = 'user-avatar';
  if (user.avatarUrl) {
    const img = document.createElement('img');
    img.src = user.avatarUrl;
    img.alt = `@${user.handle}`;
    avatar.appendChild(img);
  } else {
    // Default avatar placeholder
    avatar.innerHTML = `<span class="avatar-placeholder">${user.handle.charAt(0).toUpperCase()}</span>`;
  }
  el.appendChild(avatar);

  if (user.starred) {
    const star = document.createElement('span');
    star.className = 'user-star';
    star.textContent = '\u2605';
    el.appendChild(star);
  }

  const name = document.createElement('span');
  name.className = 'user-handle';
  name.textContent = `@${user.handle}`;
  el.appendChild(name);

  const badge = document.createElement('span');
  badge.className = 'count-badge';
  badge.textContent = user.tweetCount || 0;
  el.appendChild(badge);

  // Hover actions
  const actions = document.createElement('div');
  actions.className = 'user-actions';

  const delBtn = document.createElement('button');
  delBtn.title = 'Delete user and tweets';
  delBtn.textContent = '\u00d7';
  delBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    deleteUser(user.handle);
  });
  actions.appendChild(delBtn);

  el.appendChild(actions);

  el.addEventListener('click', () => selectUser(user.handle));
  return el;
}

function refreshUserList(updatedUser) {
  const container = document.getElementById('user-list');
  const existing = container.querySelector(`[data-handle="${updatedUser.handle}"]`);

  if (existing) {
    existing.querySelector('.count-badge').textContent = updatedUser.tweetCount || 0;
  } else {
    container.appendChild(createUserItem(updatedUser));
  }
}

// ==================== User Context Card ====================

async function showUserContext(handle) {
  const user = await sendMessage({ type: 'GET_USER', handle });
  if (!user) return;
  selectedUserData = user;

  document.getElementById('user-context').classList.remove('hidden');
  document.getElementById('llm-bar').classList.remove('hidden');

  document.getElementById('ctx-name').textContent = user.displayName || handle;
  document.getElementById('ctx-handle').textContent = `@${handle}`;
  document.getElementById('ctx-tweet-count').textContent = `${user.tweetCount || 0} tweets captured`;

  // Date range from current tweets
  if (currentTweets.length > 0) {
    const dates = currentTweets.map(t => t.timestamp).filter(Boolean).sort();
    const oldest = dates[0];
    const newest = dates[dates.length - 1];
    document.getElementById('ctx-date-range').textContent = `${formatDate(oldest)} \u2014 ${formatDate(newest)}`;
  } else {
    document.getElementById('ctx-date-range').textContent = '';
  }

  // Star button
  const starBtn = document.getElementById('ctx-star');
  starBtn.innerHTML = user.starred ? '&#9733; Starred' : '&#9734; Star';
  starBtn.className = user.starred ? 'ctx-btn starred' : 'ctx-btn';

  // Notes
  document.getElementById('user-notes').value = user.notes || '';
}

function hideUserContext() {
  document.getElementById('user-context').classList.add('hidden');
  document.getElementById('llm-bar').classList.add('hidden');
  selectedUserData = null;
}

// Star button
document.getElementById('ctx-star').addEventListener('click', async () => {
  if (!selectedUser || !selectedUserData) return;
  const isStarred = selectedUserData.starred;
  await sendMessage({ type: isStarred ? 'UNSTAR_USER' : 'STAR_USER', handle: selectedUser });
  selectedUserData.starred = !isStarred;

  const starBtn = document.getElementById('ctx-star');
  starBtn.innerHTML = selectedUserData.starred ? '&#9733; Starred' : '&#9734; Star';
  starBtn.className = selectedUserData.starred ? 'ctx-btn starred' : 'ctx-btn';

  // Refresh sidebar
  const users = await sendMessage({ type: 'GET_USERS' });
  if (users) renderUserList(users);
});

// Block button
document.getElementById('ctx-block').addEventListener('click', () => {
  if (!selectedUser) return;
  blockUserNow(selectedUser);
});

// Delete button
document.getElementById('ctx-delete').addEventListener('click', () => {
  if (!selectedUser) return;
  deleteUser(selectedUser);
});

// Notes auto-save
document.getElementById('user-notes').addEventListener('input', (e) => {
  clearTimeout(notesDebounce);
  notesDebounce = setTimeout(async () => {
    if (!selectedUser) return;
    await sendMessage({ type: 'UPDATE_USER_NOTES', handle: selectedUser, notes: e.target.value });
  }, 500);
});

// ==================== Delete / Block (immediate) ====================

async function deleteUser(handle) {
  try {
    const result = await sendMessage({ type: 'DELETE_USER', handle });
    // Check if delete succeeded - prioritize deleted:true over any error
    if (!result || (result.error && !result.deleted)) {
      console.error('[Dashboard] Delete user error:', result?.error || 'No response');
      showToast(`Error deleting @${handle}`);
      return false;
    }
    showToast(`Deleted @${handle}`);

    const userEl = document.querySelector(`#user-list [data-handle="${handle}"]`);
    if (userEl) userEl.remove();

    await refreshCounts();

    if (selectedUser === handle) {
      const users = await sendMessage({ type: 'GET_USERS' });
      if (users && users.length > 0) {
        renderUserList(users);
        selectUser(users[0].handle);
      } else {
        hideUserContext();
        renderUserList([]);
        renderTweetList([]);
      }
    }
    return true;
  } catch (err) {
    console.error('[Dashboard] Delete user exception:', err);
    showToast(`Error deleting @${handle}`);
    return false;
  }
}

async function blockUserNow(handle) {
  await sendMessage({ type: 'BLOCK_USER', handle });
  showToast(`Blocked @${handle}`);

  const userEl = document.querySelector(`#user-list [data-handle="${handle}"]`);
  if (userEl) userEl.remove();

  await refreshCounts();

  if (selectedUser === handle) {
    const users = await sendMessage({ type: 'GET_USERS' });
    if (users && users.length > 0) {
      renderUserList(users);
      selectUser(users[0].handle);
    } else {
      hideUserContext();
      renderUserList([]);
      renderTweetList([]);
    }
  }
}

async function deleteTweetNow(tweet, card) {
  await sendMessage({ type: 'DELETE_TWEET', tweetId: tweet.tweetId, handle: tweet.handle });
  currentTweets = currentTweets.filter(t => t.tweetId !== tweet.tweetId);
  card.remove();
  showToast('Tweet deleted');

  await refreshCounts();
  if (selectedUser) {
    const user = await sendMessage({ type: 'GET_USER', handle: selectedUser });
    if (user) {
      const badge = document.querySelector(`[data-handle="${selectedUser}"] .count-badge`);
      if (badge) badge.textContent = user.tweetCount || 0;
      const ctxCount = document.getElementById('ctx-tweet-count');
      if (ctxCount) ctxCount.textContent = `${user.tweetCount || 0} tweets captured`;
    }
  }
}

async function refreshCounts() {
  const count = await sendMessage({ type: 'GET_TWEET_COUNT' });
  document.getElementById('tweet-count').textContent = `${count || 0} tweets`;
}

// ==================== Tweet List ====================

function createTweetCard(tweet) {
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
        <a href="${escapeHtml(tweet.url)}" target="_blank" class="tweet-link" title="Open on X">\u2197</a>
        <button class="tweet-delete-btn" title="Delete tweet">\u00d7</button>
      </div>
      <div class="tweet-text">${escapeHtml(tweet.fullText)}</div>
    </div>
  `;

  const checkbox = card.querySelector('.tweet-checkbox');
  checkbox.addEventListener('change', () => {
    card.classList.toggle('selected', checkbox.checked);
  });

  card.querySelector('.tweet-delete-btn').addEventListener('click', () => {
    deleteTweetNow(tweet, card);
  });

  return card;
}

function renderTweetList(tweets) {
  currentTweets = tweets;
  allSelectMode = false;
  document.getElementById('select-all').textContent = 'Select All';
  const container = document.getElementById('tweet-list');
  container.innerHTML = '';

  if (tweets.length === 0) {
    container.innerHTML = '<div id="empty-state">No tweets found.</div>';
    return;
  }

  for (const tweet of tweets) {
    container.appendChild(createTweetCard(tweet));
  }
}

function appendTweet(tweet) {
  if (currentTweets.some(t => t.tweetId === tweet.tweetId)) return;

  currentTweets.unshift(tweet);

  const container = document.getElementById('tweet-list');
  const empty = container.querySelector('#empty-state');
  if (empty) empty.remove();

  container.prepend(createTweetCard(tweet));
}

async function selectUser(handle) {
  selectedUser = handle;

  document.querySelectorAll('.user-item').forEach((el) => {
    el.classList.toggle('active', el.dataset.handle === handle);
  });

  const tweets = await sendMessage({
    type: 'GET_TWEETS_BY_USER',
    handle,
    limit: 500
  });
  renderTweetList(tweets || []);
  showUserContext(handle);
}

// ==================== Search ====================

let searchDebounce;
document.getElementById('search-input').addEventListener('input', (e) => {
  clearTimeout(searchDebounce);
  searchDebounce = setTimeout(async () => {
    const query = e.target.value.trim();
    if (query.length < 2) {
      if (selectedUser) selectUser(selectedUser);
      return;
    }
    hideUserContext();
    const results = await sendMessage({ type: 'SEARCH_TWEETS', query, limit: 500 });
    renderTweetList(results || []);
  }, 300);
});

// ==================== Selection ====================

function getSelectedTweetIds() {
  return Array.from(document.querySelectorAll('.tweet-checkbox:checked')).map(cb => cb.value);
}

document.getElementById('select-all').addEventListener('click', () => {
  allSelectMode = !allSelectMode;
  document.querySelectorAll('.tweet-checkbox').forEach((cb) => {
    cb.checked = allSelectMode;
    cb.closest('.tweet-card').classList.toggle('selected', allSelectMode);
  });
  document.getElementById('select-all').textContent = allSelectMode ? 'Deselect All' : 'Select All';
});

// ==================== Export ====================

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

document.getElementById('export-selected').addEventListener('click', async () => {
  const ids = getSelectedTweetIds();
  if (ids.length === 0) {
    showToast('No tweets selected');
    return;
  }
  const tweets = currentTweets.filter(t => ids.includes(t.tweetId));
  const format = document.getElementById('export-format').value;
  await navigator.clipboard.writeText(formatTweets(tweets, format));
  showToast(`Copied ${tweets.length} tweet${tweets.length !== 1 ? 's' : ''}`);
});

document.getElementById('copy-all').addEventListener('click', async () => {
  if (currentTweets.length === 0) {
    showToast('No tweets to copy');
    return;
  }
  const format = document.getElementById('export-format').value;
  await navigator.clipboard.writeText(formatTweets(currentTweets, format));
  showToast(`Copied ${currentTweets.length} tweet${currentTweets.length !== 1 ? 's' : ''}`);
});

// ==================== LLM Prompt Templates ====================

const LLM_PROMPTS = {
  summarize: (handle, name) =>
    `Below are tweets from @${handle} (${name}). Based on these tweets, provide a comprehensive summary of this person's thinking, worldview, and main ideas. What are the key themes they discuss? What positions do they take?\n\n`,
  beliefs: (handle, name) =>
    `Below are tweets from @${handle} (${name}). Analyze these tweets and extract this person's core beliefs, values, and convictions. What do they strongly believe in? What principles guide their thinking?\n\n`,
  topics: (handle, name) =>
    `Below are tweets from @${handle} (${name}). Identify and rank the top topics/subjects this person tweets about. For each topic, give a brief summary of their stance or key points.\n\n`,
  style: (handle, name) =>
    `Below are tweets from @${handle} (${name}). Analyze their writing and communication style. How do they express ideas? What rhetorical techniques do they use? What is their tone? How could you characterize their voice?\n\n`,
  predict: (handle, name) =>
    `Below are tweets from @${handle} (${name}). Based on their established thinking patterns, beliefs, and reasoning style, predict how this person would likely respond to a current event or topic of my choosing. First, summarize their thinking framework, then I'll ask you to apply it.\n\n`
};

document.querySelectorAll('.llm-prompt').forEach((btn) => {
  btn.addEventListener('click', async () => {
    const promptType = btn.dataset.prompt;

    if (promptType === 'custom') {
      document.getElementById('prompt-modal-overlay').classList.remove('hidden');
      document.getElementById('custom-prompt-input').focus();
      return;
    }

    if (currentTweets.length === 0) {
      showToast('No tweets to send');
      return;
    }

    const handle = selectedUser || currentTweets[0].handle;
    const name = selectedUserData?.displayName || handle;
    const prompt = LLM_PROMPTS[promptType](handle, name);
    const tweetsText = formatTweets(currentTweets, 'markdown');
    const fullPrompt = prompt + tweetsText;

    await navigator.clipboard.writeText(fullPrompt);
    showToast(`Copied prompt + ${currentTweets.length} tweets`);
  });
});

// Custom prompt modal
document.getElementById('prompt-modal-close').addEventListener('click', () => {
  document.getElementById('prompt-modal-overlay').classList.add('hidden');
});

document.getElementById('prompt-modal-overlay').addEventListener('click', (e) => {
  if (e.target === e.currentTarget) e.currentTarget.classList.add('hidden');
});

document.getElementById('custom-prompt-copy').addEventListener('click', async () => {
  const customPrompt = document.getElementById('custom-prompt-input').value.trim();
  if (!customPrompt) {
    showToast('Enter a prompt first');
    return;
  }
  if (currentTweets.length === 0) {
    showToast('No tweets to send');
    return;
  }

  const handle = selectedUser || currentTweets[0].handle;
  const name = selectedUserData?.displayName || handle;
  const intro = `Below are tweets from @${handle} (${name}). ${customPrompt}\n\n`;
  const tweetsText = formatTweets(currentTweets, 'markdown');
  const fullPrompt = intro + tweetsText;

  await navigator.clipboard.writeText(fullPrompt);
  document.getElementById('prompt-modal-overlay').classList.add('hidden');
  showToast(`Copied prompt + ${currentTweets.length} tweets`);
});

// ==================== Cleanup: Remove Low-Count Users ====================

document.getElementById('cleanup-btn').addEventListener('click', async () => {
  const threshold = parseInt(document.getElementById('cleanup-threshold').value, 10);
  if (isNaN(threshold) || threshold < 1) {
    showToast('Invalid threshold value');
    return;
  }

  const users = await sendMessage({ type: 'GET_USERS' });
  if (!users || !Array.isArray(users)) {
    showToast('Failed to get users');
    return;
  }

  // Filter users where tweetCount is less than or equal to threshold
  // tweetCount might be undefined, null, or 0 - treat all as 0
  const toRemove = users.filter(u => {
    const count = typeof u.tweetCount === 'number' ? u.tweetCount : 0;
    return count <= threshold;
  });

  console.log('[Dashboard] Cleanup: threshold =', threshold, ', users to remove =', toRemove.length, toRemove.map(u => `@${u.handle}(${u.tweetCount})`));

  if (toRemove.length === 0) {
    showToast('No users to remove');
    return;
  }

  // Delete all from DB - use Promise.all for better performance
  let deletedCount = 0;
  for (const user of toRemove) {
    try {
      const result = await sendMessage({ type: 'DELETE_USER', handle: user.handle });
      if (result && !result.error) {
        deletedCount++;
      }
    } catch (err) {
      console.error('[Dashboard] Failed to delete user:', user.handle, err);
    }
  }

  showToast(`Removed ${deletedCount} user${deletedCount !== 1 ? 's' : ''}`);

  await refreshCounts();
  const remaining = await sendMessage({ type: 'GET_USERS' });
  if (remaining && remaining.length > 0) {
    renderUserList(remaining);
    selectUser(remaining[0].handle);
  } else {
    hideUserContext();
    renderUserList([]);
    renderTweetList([]);
  }
});

// ==================== Export / Import Database ====================

document.getElementById('export-db-btn').addEventListener('click', async () => {
  try {
    const data = await sendMessage({ type: 'EXPORT_DATABASE' });
    if (!data || data.error) {
      showToast('Export failed');
      return;
    }

    // Create downloadable JSON file
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `x-vault-backup-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    showToast(`Exported ${data.tweets.length} tweets, ${data.users.length} users`);
  } catch (err) {
    console.error('[Dashboard] Export failed:', err);
    showToast('Export failed');
  }
});

document.getElementById('import-db-btn').addEventListener('click', () => {
  document.getElementById('import-file-input').click();
});

document.getElementById('import-file-input').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;

  try {
    const text = await file.text();
    const data = JSON.parse(text);

    // Validate basic structure
    if (!data.tweets && !data.users) {
      showToast('Invalid backup file');
      return;
    }

    const result = await sendMessage({ type: 'IMPORT_DATABASE', data, merge: true });
    if (!result || result.error) {
      showToast('Import failed');
      return;
    }

    showToast(`Imported ${result.imported.tweets} tweets, ${result.imported.users} users`);
    await reloadAll();
  } catch (err) {
    console.error('[Dashboard] Import failed:', err);
    showToast('Import failed: Invalid file');
  }

  // Reset file input
  e.target.value = '';
});

// ==================== Blocked Users Modal ====================

document.getElementById('blocked-list-btn').addEventListener('click', async () => {
  await renderBlockedList();
  document.getElementById('modal-overlay').classList.remove('hidden');
});

document.getElementById('modal-close').addEventListener('click', () => {
  document.getElementById('modal-overlay').classList.add('hidden');
});

document.getElementById('modal-overlay').addEventListener('click', (e) => {
  if (e.target === e.currentTarget) e.currentTarget.classList.add('hidden');
});

async function renderBlockedList() {
  const blocked = await sendMessage({ type: 'GET_BLOCKED_USERS' });
  const list = document.getElementById('blocked-list');
  const empty = document.getElementById('blocked-empty');
  list.innerHTML = '';

  if (!blocked || blocked.length === 0) {
    empty.classList.remove('hidden');
    return;
  }

  empty.classList.add('hidden');
  for (const handle of blocked) {
    const item = document.createElement('div');
    item.className = 'blocked-item';

    const name = document.createElement('span');
    name.textContent = `@${handle}`;
    item.appendChild(name);

    const unblockBtn = document.createElement('button');
    unblockBtn.textContent = 'Unblock';
    unblockBtn.addEventListener('click', async () => {
      await sendMessage({ type: 'UNBLOCK_USER', handle });
      showToast(`Unblocked @${handle}`);
      await renderBlockedList();
    });
    item.appendChild(unblockBtn);

    list.appendChild(item);
  }
}

document.getElementById('block-add-btn').addEventListener('click', async () => {
  const input = document.getElementById('block-input');
  let handle = input.value.trim().toLowerCase().replace(/^@/, '');
  if (!handle) return;

  await sendMessage({ type: 'BLOCK_USER', handle });
  input.value = '';
  showToast(`Blocked @${handle}`);
  await renderBlockedList();
  await reloadAll();
});

// ==================== Settings Modal ====================

document.getElementById('settings-btn').addEventListener('click', async () => {
  // Load current settings
  const settings = await sendMessage({ type: 'GET_HOME_FEED_SETTINGS' });

  const enabledCheckbox = document.getElementById('home-capture-enabled');
  const thresholdsDiv = document.getElementById('home-capture-thresholds');
  const minLikesInput = document.getElementById('min-likes');
  const minImpressionsInput = document.getElementById('min-impressions');

  enabledCheckbox.checked = settings?.enabled || false;
  minLikesInput.value = settings?.minLikes || 0;
  minImpressionsInput.value = settings?.minImpressions || 0;

  // Show/hide thresholds based on enabled state
  thresholdsDiv.classList.toggle('hidden', !enabledCheckbox.checked);

  document.getElementById('settings-modal-overlay').classList.remove('hidden');
});

// Toggle threshold visibility when checkbox changes
document.getElementById('home-capture-enabled').addEventListener('change', (e) => {
  document.getElementById('home-capture-thresholds').classList.toggle('hidden', !e.target.checked);
});

document.getElementById('settings-modal-close').addEventListener('click', () => {
  document.getElementById('settings-modal-overlay').classList.add('hidden');
});

document.getElementById('settings-modal-overlay').addEventListener('click', (e) => {
  if (e.target === e.currentTarget) e.currentTarget.classList.add('hidden');
});

document.getElementById('settings-save-btn').addEventListener('click', async () => {
  const enabled = document.getElementById('home-capture-enabled').checked;
  const minLikes = parseInt(document.getElementById('min-likes').value, 10) || 0;
  const minImpressions = parseInt(document.getElementById('min-impressions').value, 10) || 0;

  await sendMessage({
    type: 'SET_HOME_FEED_SETTINGS',
    settings: { enabled, minLikes, minImpressions }
  });

  document.getElementById('settings-modal-overlay').classList.add('hidden');
  showToast('Settings saved');
});

// ==================== Real-time Updates ====================

chrome.runtime.onMessage.addListener((message) => {
  if (message.type !== 'TWEET_ADDED') return;

  document.getElementById('tweet-count').textContent = `${message.totalCount} tweets`;
  refreshUserList(message.user);

  if (selectedUser === message.tweet.handle) {
    appendTweet(message.tweet);
    document.getElementById('ctx-tweet-count').textContent = `${message.user.tweetCount || 0} tweets captured`;
  }
});

// ==================== Init ====================

async function reloadAll() {
  selectedUser = null;
  selectedUserData = null;
  hideUserContext();

  const count = await sendMessage({ type: 'GET_TWEET_COUNT' });
  document.getElementById('tweet-count').textContent = `${count || 0} tweets`;

  const users = await sendMessage({ type: 'GET_USERS' });
  if (users && users.length > 0) {
    renderUserList(users);
    selectUser(users[0].handle);
  } else {
    renderUserList([]);
    renderTweetList([]);
  }
}

document.addEventListener('DOMContentLoaded', reloadAll);
