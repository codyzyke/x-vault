let currentTweets = [];
let selectedUser = null;
let selectedUserData = null;
let allSelectMode = false;
let notesDebounce = null;
let currentView = 'home';
let currentSort = 'date';
let editingPostId = null; // Track if editing existing post

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

function formatMetricCount(n) {
  if (!n || n === 0) return '';
  if (n >= 1000000) return (n / 1000000).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'K';
  return String(n);
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
  document.getElementById('sort-bar').classList.remove('hidden');

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

  // Blog posts
  await loadBlogPosts(handle);
}

function hideUserContext() {
  document.getElementById('user-context').classList.add('hidden');
  document.getElementById('llm-bar').classList.add('hidden');
  document.getElementById('sort-bar').classList.add('hidden');
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

// ==================== Blog Posts ====================

async function loadBlogPosts(handle) {
  const posts = await sendMessage({ type: 'GET_BLOG_POSTS_BY_USER', handle });
  renderBlogPostsList(posts || []);
}

function renderBlogPostsList(posts) {
  const container = document.getElementById('blog-posts-list');
  container.innerHTML = '';

  if (posts.length === 0) {
    container.innerHTML = '<div class="blog-posts-empty">No blog posts yet.</div>';
    return;
  }

  for (const post of posts) {
    const item = document.createElement('div');
    item.className = 'blog-post-item';
    item.dataset.postId = post.postId;

    const title = post.title || 'Untitled Post';
    const preview = post.content ? post.content.substring(0, 80) + (post.content.length > 80 ? '...' : '') : '';
    const date = new Date(post.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

    item.innerHTML = `
      <div class="blog-post-item-content">
        <span class="blog-post-item-title">${escapeHtml(title)}</span>
        <span class="blog-post-item-preview">${escapeHtml(preview)}</span>
        <span class="blog-post-item-date">${date}</span>
      </div>
      <button class="blog-post-item-edit" title="Edit post">Edit</button>
    `;

    item.querySelector('.blog-post-item-edit').addEventListener('click', (e) => {
      e.stopPropagation();
      openBlogPostModal(post);
    });

    item.addEventListener('click', () => openBlogPostModal(post));
    container.appendChild(item);
  }
}

function openBlogPostModal(post = null) {
  editingPostId = post ? post.postId : null;

  const titleEl = document.getElementById('blog-post-modal-title');
  const titleInput = document.getElementById('blog-post-title-input');
  const contentInput = document.getElementById('blog-post-content-input');
  const deleteBtn = document.getElementById('blog-post-delete-btn');

  if (post) {
    titleEl.textContent = 'Edit Blog Post';
    titleInput.value = post.title || '';
    contentInput.value = post.content || '';
    deleteBtn.classList.remove('hidden');
  } else {
    titleEl.textContent = 'New Blog Post';
    titleInput.value = '';
    contentInput.value = '';
    deleteBtn.classList.add('hidden');
  }

  document.getElementById('blog-post-modal-overlay').classList.remove('hidden');
  titleInput.focus();
}

function closeBlogPostModal() {
  document.getElementById('blog-post-modal-overlay').classList.add('hidden');
  editingPostId = null;
}

// Add new post button
document.getElementById('add-blog-post-btn').addEventListener('click', () => {
  if (!selectedUser) return;
  openBlogPostModal();
});

// Close modal
document.getElementById('blog-post-modal-close').addEventListener('click', closeBlogPostModal);
document.getElementById('blog-post-modal-overlay').addEventListener('click', (e) => {
  if (e.target === e.currentTarget) closeBlogPostModal();
});

// Save blog post
document.getElementById('blog-post-save-btn').addEventListener('click', async () => {
  if (!selectedUser) return;

  const title = document.getElementById('blog-post-title-input').value.trim();
  const content = document.getElementById('blog-post-content-input').value.trim();

  if (!content && !title) {
    showToast('Please enter some content');
    return;
  }

  if (editingPostId) {
    // Update existing post
    await sendMessage({
      type: 'UPDATE_BLOG_POST',
      postId: editingPostId,
      updates: { title, content }
    });
    showToast('Post updated');
  } else {
    // Create new post
    await sendMessage({
      type: 'STORE_BLOG_POST',
      post: { handle: selectedUser, title, content }
    });
    showToast('Post created');
  }

  closeBlogPostModal();
  await loadBlogPosts(selectedUser);
});

// Delete blog post
document.getElementById('blog-post-delete-btn').addEventListener('click', async () => {
  if (!editingPostId) return;

  await sendMessage({ type: 'DELETE_BLOG_POST', postId: editingPostId });
  showToast('Post deleted');
  closeBlogPostModal();
  await loadBlogPosts(selectedUser);
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

// ==================== Sort ====================

function sortTweets(tweets, sortBy) {
  switch (sortBy) {
    case 'likes':
      return [...tweets].sort((a, b) => (b.likeCount || 0) - (a.likeCount || 0));
    case 'views':
      return [...tweets].sort((a, b) => (b.viewCount || b.impressionCount || 0) - (a.viewCount || a.impressionCount || 0));
    case 'date':
    default:
      return [...tweets].sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  }
}

function applySortAndRender() {
  const sorted = sortTweets(currentTweets, currentSort);
  const container = document.getElementById('tweet-list');
  container.innerHTML = '';
  if (sorted.length === 0) {
    container.innerHTML = '<div id="empty-state">No tweets found.</div>';
    return;
  }
  for (const tweet of sorted) {
    container.appendChild(createTweetCard(tweet));
  }
}

document.querySelectorAll('.sort-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    currentSort = btn.dataset.sort;
    document.querySelectorAll('.sort-btn').forEach(b => b.classList.toggle('active', b === btn));
    applySortAndRender();
  });
});

async function selectUser(handle) {
  selectedUser = handle;

  // Reset sort to date
  currentSort = 'date';
  document.querySelectorAll('.sort-btn').forEach(b => b.classList.toggle('active', b.dataset.sort === 'date'));

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

function formatTweetsForLLM(tweets) {
  return tweets
    .map(t => t.fullText)
    .filter(Boolean)
    .join('\n---\n');
}

const LLM_PROMPTS = {
  summarize: (handle, name) =>
    `Below are tweets from @${handle} (${name}). Provide a comprehensive summary of this person's thinking, worldview, and main ideas. What are the key themes? What positions do they take?\n\n`,
  beliefs: (handle, name) =>
    `Below are tweets from @${handle} (${name}). Extract this person's core beliefs, values, and convictions. What do they strongly believe in? What principles guide their thinking?\n\n`,
  topics: (handle, name) =>
    `Below are tweets from @${handle} (${name}). Identify and rank the top topics this person tweets about. For each topic, summarize their stance.\n\n`,
  style: (handle, name) =>
    `Below are tweets from @${handle} (${name}). Analyze their writing style, tone, and rhetorical techniques. How would you characterize their voice?\n\n`,
  predict: (handle, name) =>
    `Below are tweets from @${handle} (${name}). Based on their thinking patterns and beliefs, predict how they would respond to a topic of my choosing. First, summarize their thinking framework.\n\n`
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
    const tweetsText = formatTweetsForLLM(currentTweets);
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
  const tweetsText = formatTweetsForLLM(currentTweets);
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

// ==================== Blocked Users (Inline in Settings) ====================

async function renderBlockedListInline() {
  const blocked = await sendMessage({ type: 'GET_BLOCKED_USERS' });
  const list = document.getElementById('blocked-list-inline');
  list.innerHTML = '';

  if (!blocked || blocked.length === 0) {
    list.innerHTML = '<span style="color: #657786; font-size: 12px;">No blocked users yet.</span>';
    return;
  }

  for (const handle of blocked) {
    const tag = document.createElement('span');
    tag.className = 'blocked-tag';
    tag.innerHTML = `@${handle} <button title="Unblock">&times;</button>`;

    tag.querySelector('button').addEventListener('click', async () => {
      await sendMessage({ type: 'UNBLOCK_USER', handle });
      showToast(`Unblocked @${handle}`);
      await renderBlockedListInline();
    });

    list.appendChild(tag);
  }
}

document.getElementById('block-add-btn').addEventListener('click', async () => {
  const input = document.getElementById('block-input');
  let handle = input.value.trim().toLowerCase().replace(/^@/, '');
  if (!handle) return;

  await sendMessage({ type: 'BLOCK_USER', handle });
  input.value = '';
  showToast(`Blocked @${handle}`);
  await renderBlockedListInline();
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

  // Load blocked users inline
  await renderBlockedListInline();

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

// ==================== View Navigation ====================

function showView(viewName) {
  currentView = viewName;

  // Update nav items
  document.querySelectorAll('.nav-item').forEach(item => {
    item.classList.toggle('active', item.dataset.view === viewName);
  });

  // Update views
  document.querySelectorAll('.view').forEach(view => {
    view.classList.toggle('active', view.id === `view-${viewName}`);
  });

  // Show/hide footer (only in users view)
  const footer = document.getElementById('tweet-footer');
  if (footer) {
    footer.classList.toggle('hidden', viewName !== 'users');
  }

  // Load view-specific data
  if (viewName === 'home') {
    loadHomeView();
  } else if (viewName === 'users') {
    loadUsersView();
  } else if (viewName === 'search') {
    document.getElementById('search-input').focus();
  } else if (viewName === 'ai') {
    loadAIView();
  }
}

// Navigation click handlers
document.querySelectorAll('.nav-menu .nav-item').forEach(item => {
  item.addEventListener('click', () => {
    showView(item.dataset.view);
  });
});

// ==================== Home View ====================

async function loadHomeView() {
  // Load stats
  const count = await sendMessage({ type: 'GET_TWEET_COUNT' });
  const users = await sendMessage({ type: 'GET_USERS' });

  const totalTweets = count || 0;
  const totalUsers = users?.length || 0;
  const starredUsers = users?.filter(u => u.starred)?.length || 0;

  document.getElementById('stat-total-tweets').textContent = totalTweets;
  document.getElementById('stat-total-users').textContent = totalUsers;
  document.getElementById('stat-starred-users').textContent = starredUsers;
  document.getElementById('tweet-count').textContent = `${totalTweets} tweets`;

  // Load recent tweets by capture time
  const recentTweets = await sendMessage({ type: 'GET_RECENT_TWEETS', limit: 50 });
  renderRecentTweets(recentTweets || []);
}

function renderRecentTweets(tweets) {
  const container = document.getElementById('recent-tweets');
  container.innerHTML = '';

  if (tweets.length === 0) {
    container.innerHTML = '<div class="empty-state">Browse a Twitter/X profile to start capturing tweets.</div>';
    return;
  }

  // Sort by capturedAt descending
  tweets.sort((a, b) => new Date(b.capturedAt) - new Date(a.capturedAt));

  for (const tweet of tweets.slice(0, 30)) {
    container.appendChild(createGridCard(tweet));
  }
}

// Shared metrics HTML builder (SVG icons)
function buildMetricsHtml(tweet) {
  const metrics = [];
  if (tweet.replyCount) metrics.push(`<span class="grid-metric" title="Replies"><svg viewBox="0 0 24 24" width="14" height="14"><path d="M1.751 10c0-4.42 3.584-8 8.005-8h4.366c4.49 0 8.129 3.64 8.129 8.13 0 2.25-.893 4.306-2.394 5.82l-4.36 4.36a.75.75 0 01-1.06 0l-.72-.72a.75.75 0 010-1.06l4.36-4.36A5.63 5.63 0 0020.501 10.13 6.38 6.38 0 0014.122 3.75h-4.366a6.25 6.25 0 00-6.255 6.25c0 1.903.855 3.604 2.2 4.748l.09.07a.75.75 0 01-.48 1.34H3.59a.75.75 0 01-.54-.23A7.98 7.98 0 011.751 10z" fill="currentColor"/></svg> ${formatMetricCount(tweet.replyCount)}</span>`);
  if (tweet.retweetCount) metrics.push(`<span class="grid-metric" title="Reposts"><svg viewBox="0 0 24 24" width="14" height="14"><path d="M4.5 3.88l4.432 4.14-1.364 1.46L5.5 7.55V16c0 1.1.896 2 2 2h3v2h-3c-2.209 0-4-1.79-4-4V7.55L1.432 9.48.068 8.02 4.5 3.88zM19.5 20.12l-4.432-4.14 1.364-1.46 2.068 1.93V8c0-1.1-.896-2-2-2h-3V4h3c2.209 0 4 1.79 4 4v8.45l2.068-1.93 1.364 1.46-4.432 4.14z" fill="currentColor"/></svg> ${formatMetricCount(tweet.retweetCount)}</span>`);
  if (tweet.likeCount) metrics.push(`<span class="grid-metric" title="Likes"><svg viewBox="0 0 24 24" width="14" height="14"><path d="M16.697 5.5c-1.222-.06-2.679.51-3.89 2.16l-.805 1.09-.806-1.09C9.984 6.01 8.526 5.44 7.304 5.5c-1.243.07-2.349.78-2.91 1.91-.552 1.12-.633 2.78.479 4.82 1.074 1.97 3.257 4.27 7.129 6.61 3.87-2.34 6.052-4.64 7.126-6.61 1.111-2.04 1.03-3.7.477-4.82-.56-1.13-1.666-1.84-2.908-1.91z" fill="currentColor"/></svg> ${formatMetricCount(tweet.likeCount)}</span>`);
  if (tweet.bookmarkCount) metrics.push(`<span class="grid-metric" title="Bookmarks"><svg viewBox="0 0 24 24" width="14" height="14"><path d="M4 4.5C4 3.12 5.119 2 6.5 2h11C18.881 2 20 3.12 20 4.5v18.44l-8-5.71-8 5.71V4.5z" fill="currentColor"/></svg> ${formatMetricCount(tweet.bookmarkCount)}</span>`);
  if (tweet.viewCount || tweet.impressionCount) metrics.push(`<span class="grid-metric" title="Views"><svg viewBox="0 0 24 24" width="14" height="14"><path d="M8.75 21V3h2v18h-2zM18.75 21V8.5h2V21h-2zM13.75 21v-9h2v9h-2zM3.75 21v-4h2v4h-2z" fill="currentColor"/></svg> ${formatMetricCount(tweet.viewCount || tweet.impressionCount)}</span>`);
  return metrics.length > 0 ? `<div class="grid-metrics">${metrics.join('')}</div>` : '';
}

// Shared avatar HTML builder
function buildAvatarHtml(tweet) {
  return tweet.avatarUrl
    ? `<img class="grid-avatar" src="${escapeHtml(tweet.avatarUrl)}" alt="@${escapeHtml(tweet.handle)}">`
    : `<div class="grid-avatar grid-avatar-placeholder">${escapeHtml(tweet.handle.charAt(0).toUpperCase())}</div>`;
}

function createGridCard(tweet, { selectable = false } = {}) {
  const card = document.createElement('div');
  card.className = 'grid-card';
  card.dataset.tweetId = tweet.tweetId;

  let retweetHtml = '';
  if (tweet.isRetweet && tweet.retweetedBy) {
    retweetHtml = `<div class="retweet-badge">Reposted by @${escapeHtml(tweet.retweetedBy)}</div>`;
  }

  const deleteBtn = selectable ? `<button class="grid-card-delete" title="Delete tweet">\u00d7</button>` : '';
  const checkboxHtml = selectable ? `<input type="checkbox" class="grid-card-checkbox tweet-checkbox" value="${escapeHtml(tweet.tweetId)}">` : '';

  card.innerHTML = `
    ${retweetHtml}
    <div class="grid-card-header">
      ${buildAvatarHtml(tweet)}
      <div class="grid-card-user">
        <span class="grid-card-name">${escapeHtml(tweet.displayName)}</span>
        <span class="grid-card-handle">@${escapeHtml(tweet.handle)} &middot; ${formatTimestamp(tweet.timestamp)}</span>
      </div>
      <a href="${escapeHtml(tweet.url)}" target="_blank" class="grid-card-link" title="Open on X">\u2197</a>
      ${deleteBtn}
    </div>
    ${tweet.fullText ? `<div class="grid-card-text">${escapeHtml(tweet.fullText)}</div>` : '<div class="grid-card-text grid-card-text-empty">No text captured</div>'}
    ${buildMetricsHtml(tweet)}
    ${checkboxHtml}
  `;

  if (selectable) {
    const checkbox = card.querySelector('.grid-card-checkbox');
    if (checkbox) {
      checkbox.addEventListener('change', () => {
        card.classList.toggle('selected', checkbox.checked);
      });
    }

    const delBtn = card.querySelector('.grid-card-delete');
    if (delBtn) {
      delBtn.addEventListener('click', () => deleteTweetNow(tweet, card));
    }
  }

  return card;
}

// Alias for backward compat
function createTweetCard(tweet, isReadOnly = false) {
  return createGridCard(tweet, { selectable: !isReadOnly });
}

// ==================== Users View ====================

async function loadUsersView() {
  const users = await sendMessage({ type: 'GET_USERS' });
  if (users && users.length > 0) {
    renderUserList(users);
    if (!selectedUser) {
      selectUser(users[0].handle);
    }
  } else {
    renderUserList([]);
    document.getElementById('tweet-list').innerHTML = '<div class="empty-state">No users tracked yet.</div>';
  }
}

// ==================== Search View ====================

document.getElementById('search-input').addEventListener('input', (e) => {
  clearTimeout(searchDebounce);
  searchDebounce = setTimeout(async () => {
    const query = e.target.value.trim();
    const container = document.getElementById('search-results');

    if (query.length < 2) {
      container.innerHTML = '<div class="empty-state">Enter a search term to find tweets.</div>';
      return;
    }

    const results = await sendMessage({ type: 'SEARCH_TWEETS', query, limit: 500 });
    container.innerHTML = '';

    if (!results || results.length === 0) {
      container.innerHTML = '<div class="empty-state">No tweets found.</div>';
      return;
    }

    for (const tweet of results) {
      container.appendChild(createTweetCard(tweet, true));
    }
  }, 300);
});

let searchDebounce;

// ==================== AI Replies View ====================

let aiSelectedTweets = [];
let aiSearchDebounce = null;

// Toggle settings panel
document.getElementById('ai-settings-toggle').addEventListener('click', () => {
  document.getElementById('ai-settings-panel').classList.toggle('hidden');
});

// Save AI settings
document.getElementById('ai-save-settings').addEventListener('click', async () => {
  const apiKey = document.getElementById('ai-api-key').value.trim();
  const provider = document.getElementById('ai-provider').value;
  const model = document.getElementById('ai-model').value.trim() || 'gpt-4o-mini';
  const systemPrompt = document.getElementById('ai-system-prompt').value.trim();

  await sendMessage({
    type: 'SET_AI_SETTINGS',
    settings: { apiKey, provider, model, systemPrompt }
  });

  document.getElementById('ai-settings-panel').classList.add('hidden');
  showToast('AI settings saved');
});

// Load AI settings into form
async function loadAISettings() {
  const settings = await sendMessage({ type: 'GET_AI_SETTINGS' });
  if (settings) {
    document.getElementById('ai-api-key').value = settings.apiKey || '';
    document.getElementById('ai-provider').value = settings.provider || 'openai';
    document.getElementById('ai-model').value = settings.model || 'gpt-4o-mini';
    document.getElementById('ai-system-prompt').value = settings.systemPrompt || '';
  }
}

// Load recent tweets into AI tweet browser
document.getElementById('ai-load-recent').addEventListener('click', async () => {
  const tweets = await sendMessage({ type: 'GET_RECENT_TWEETS', limit: 50 });
  renderAITweetList(tweets || []);
});

// Search tweets in AI view
document.getElementById('ai-tweet-search').addEventListener('input', (e) => {
  clearTimeout(aiSearchDebounce);
  aiSearchDebounce = setTimeout(async () => {
    const query = e.target.value.trim();
    if (query.length < 2) {
      // Load recent if search cleared
      const tweets = await sendMessage({ type: 'GET_RECENT_TWEETS', limit: 50 });
      renderAITweetList(tweets || []);
      return;
    }
    const results = await sendMessage({ type: 'SEARCH_TWEETS', query, limit: 50 });
    renderAITweetList(results || []);
  }, 300);
});

function renderAITweetList(tweets) {
  const container = document.getElementById('ai-tweet-list');
  container.innerHTML = '';

  if (tweets.length === 0) {
    container.innerHTML = '<div class="empty-state">No tweets found.</div>';
    return;
  }

  for (const tweet of tweets) {
    const item = document.createElement('div');
    item.className = 'ai-tweet-item';
    if (aiSelectedTweets.some(t => t.tweetId === tweet.tweetId)) {
      item.classList.add('selected');
    }

    const avatarHtml = tweet.avatarUrl
      ? `<img class="ai-tweet-item-avatar" src="${escapeHtml(tweet.avatarUrl)}" alt="@${escapeHtml(tweet.handle)}">`
      : `<div class="ai-tweet-item-avatar-placeholder">${escapeHtml(tweet.handle.charAt(0).toUpperCase())}</div>`;

    item.innerHTML = `
      ${avatarHtml}
      <div class="ai-tweet-item-content">
        <div class="ai-tweet-item-header">
          <span class="ai-tweet-item-name">${escapeHtml(tweet.displayName)}</span>
          <span class="ai-tweet-item-handle">@${escapeHtml(tweet.handle)}</span>
        </div>
        <div class="ai-tweet-item-text">${escapeHtml(tweet.fullText || '')}</div>
      </div>
      <div class="ai-tweet-item-check"></div>
    `;

    item.addEventListener('click', () => toggleAITweetSelection(tweet, item));
    container.appendChild(item);
  }
}

function toggleAITweetSelection(tweet, itemEl) {
  const idx = aiSelectedTweets.findIndex(t => t.tweetId === tweet.tweetId);
  if (idx >= 0) {
    aiSelectedTweets.splice(idx, 1);
    itemEl.classList.remove('selected');
  } else {
    aiSelectedTweets.push(tweet);
    itemEl.classList.add('selected');
  }
  updateAISelectedDisplay();
}

function updateAISelectedDisplay() {
  document.getElementById('ai-selected-count').textContent = aiSelectedTweets.length;

  const container = document.getElementById('ai-selected-tweets');
  container.innerHTML = '';

  for (const tweet of aiSelectedTweets) {
    const chip = document.createElement('span');
    chip.className = 'ai-selected-chip';

    const textSpan = document.createElement('span');
    textSpan.className = 'ai-selected-chip-text';
    const preview = tweet.fullText
      ? `@${tweet.handle}: ${tweet.fullText.slice(0, 60)}${tweet.fullText.length > 60 ? '...' : ''}`
      : `@${tweet.handle}`;
    textSpan.textContent = preview;
    chip.appendChild(textSpan);

    const removeBtn = document.createElement('button');
    removeBtn.textContent = '\u00d7';
    removeBtn.addEventListener('click', () => {
      aiSelectedTweets = aiSelectedTweets.filter(t => t.tweetId !== tweet.tweetId);
      updateAISelectedDisplay();
      // Update list item visual
      const listItem = document.querySelector(`.ai-tweet-item.selected`);
      document.querySelectorAll('.ai-tweet-item').forEach(el => {
        const text = el.querySelector('.ai-tweet-item-text')?.textContent;
        if (text === (tweet.fullText || '') && !aiSelectedTweets.some(t => (t.fullText || '') === text)) {
          el.classList.remove('selected');
        }
      });
    });
    chip.appendChild(removeBtn);
    container.appendChild(chip);
  }
}

// Clear selected
document.getElementById('ai-clear-selected').addEventListener('click', () => {
  aiSelectedTweets = [];
  updateAISelectedDisplay();
  document.querySelectorAll('.ai-tweet-item.selected').forEach(el => el.classList.remove('selected'));
});

// Generate replies
document.getElementById('ai-generate-btn').addEventListener('click', async () => {
  if (aiSelectedTweets.length === 0) {
    showToast('Select at least one tweet');
    return;
  }

  const settings = await sendMessage({ type: 'GET_AI_SETTINGS' });
  if (!settings?.apiKey) {
    showToast('Set your API key in AI Settings first');
    document.getElementById('ai-settings-panel').classList.remove('hidden');
    return;
  }

  const customPrompt = document.getElementById('ai-prompt-input').value.trim();
  const btn = document.getElementById('ai-generate-btn');
  const resultsContainer = document.getElementById('ai-results');

  btn.disabled = true;
  btn.classList.add('loading');
  btn.textContent = 'Generating...';
  resultsContainer.innerHTML = '<div class="empty-state">Generating reply ideas...</div>';

  try {
    const tweetsContext = aiSelectedTweets.map((t, i) =>
      `[Tweet ${i + 1}] @${t.handle} (${t.displayName}):\n${t.fullText || '(no text)'}`
    ).join('\n\n---\n\n');

    const userPrompt = customPrompt
      ? `${customPrompt}\n\nHere are the tweets:\n\n${tweetsContext}`
      : `Generate engaging reply ideas for each of these tweets:\n\n${tweetsContext}`;

    const systemPrompt = settings.systemPrompt ||
      'You are a witty and thoughtful Twitter/X user. Generate reply ideas for the given tweets. For each tweet, provide 2-3 possible reply options that are engaging, relevant, and match different tones (e.g., insightful, humorous, agreeable, challenging). Keep replies concise and tweet-length (under 280 characters). Format your response as JSON: [{"tweetIndex": 1, "replies": ["reply1", "reply2", "reply3"]}, ...]';

    const provider = settings.provider || 'openai';
    let apiUrl, headers, body;

    if (provider === 'openrouter') {
      apiUrl = 'https://openrouter.ai/api/v1/chat/completions';
      headers = {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${settings.apiKey}`
      };
    } else {
      apiUrl = 'https://api.openai.com/v1/chat/completions';
      headers = {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${settings.apiKey}`
      };
    }

    body = JSON.stringify({
      model: settings.model || 'gpt-4o-mini',
      messages: [
        { role: 'system', content: systemPrompt + '\n\nIMPORTANT: Always respond with valid JSON array format: [{"tweetIndex": 1, "replies": ["reply1", "reply2"]}, ...]' },
        { role: 'user', content: userPrompt }
      ],
      temperature: 0.8,
      max_tokens: 2000
    });

    const response = await fetch(apiUrl, { method: 'POST', headers, body });

    if (!response.ok) {
      const errData = await response.json().catch(() => ({}));
      throw new Error(errData.error?.message || `API error: ${response.status}`);
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content || '';

    renderAIResults(content);
  } catch (err) {
    console.error('[X-Vault] AI generation failed:', err);
    resultsContainer.innerHTML = `<div class="ai-error">Error: ${escapeHtml(err.message)}</div>`;
  } finally {
    btn.disabled = false;
    btn.classList.remove('loading');
    btn.textContent = 'Generate Replies';
  }
});

function renderAIResults(content) {
  const container = document.getElementById('ai-results');
  container.innerHTML = '';

  // Try to parse as JSON first
  let parsed = null;
  try {
    // Extract JSON from markdown code blocks if wrapped
    const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/) || [null, content];
    parsed = JSON.parse(jsonMatch[1].trim());
  } catch (e) {
    // Fallback: render as plain text with copy buttons
    renderAIResultsPlainText(container, content);
    return;
  }

  if (Array.isArray(parsed)) {
    for (const item of parsed) {
      const tweetIdx = (item.tweetIndex || 1) - 1;
      const tweet = aiSelectedTweets[tweetIdx];

      const card = document.createElement('div');
      card.className = 'ai-result-card';

      if (tweet) {
        const ref = document.createElement('div');
        ref.className = 'ai-result-tweet-ref';
        ref.innerHTML = `<strong>@${escapeHtml(tweet.handle)}</strong>: ${escapeHtml(tweet.fullText || '')}`;
        card.appendChild(ref);
      }

      const replies = item.replies || [];
      for (const reply of replies) {
        const option = document.createElement('div');
        option.className = 'ai-reply-option';

        const text = document.createElement('div');
        text.className = 'ai-reply-text';
        text.textContent = reply;
        option.appendChild(text);

        const copyBtn = document.createElement('button');
        copyBtn.className = 'ai-copy-btn';
        copyBtn.textContent = 'Copy';
        copyBtn.addEventListener('click', async () => {
          await navigator.clipboard.writeText(reply);
          copyBtn.textContent = 'Copied!';
          copyBtn.classList.add('copied');
          setTimeout(() => {
            copyBtn.textContent = 'Copy';
            copyBtn.classList.remove('copied');
          }, 1500);
        });
        option.appendChild(copyBtn);
        card.appendChild(option);
      }

      container.appendChild(card);
    }
  } else {
    renderAIResultsPlainText(container, content);
  }
}

function renderAIResultsPlainText(container, content) {
  // Split by lines that look like replies (starting with - or numbered)
  const lines = content.split('\n').filter(l => l.trim());
  let currentCard = null;

  for (const line of lines) {
    const trimmed = line.trim();

    // Detect tweet reference headers (e.g. "Tweet 1:" or "[Tweet 1]" or "**@handle**")
    if (/^(\[?tweet\s*\d+\]?|#{1,3}\s|.*@\w+.*:)/i.test(trimmed)) {
      currentCard = document.createElement('div');
      currentCard.className = 'ai-result-card';
      const ref = document.createElement('div');
      ref.className = 'ai-result-tweet-ref';
      ref.textContent = trimmed.replace(/^#+\s*/, '').replace(/\*\*/g, '');
      currentCard.appendChild(ref);
      container.appendChild(currentCard);
      continue;
    }

    // Reply lines (starting with - or number.)
    const replyMatch = trimmed.match(/^[-*]\s+(.+)/) || trimmed.match(/^\d+[.)]\s+(.+)/);
    if (replyMatch) {
      if (!currentCard) {
        currentCard = document.createElement('div');
        currentCard.className = 'ai-result-card';
        container.appendChild(currentCard);
      }

      const option = document.createElement('div');
      option.className = 'ai-reply-option';

      const text = document.createElement('div');
      text.className = 'ai-reply-text';
      text.textContent = replyMatch[1].replace(/^["']|["']$/g, '');
      option.appendChild(text);

      const copyBtn = document.createElement('button');
      copyBtn.className = 'ai-copy-btn';
      copyBtn.textContent = 'Copy';
      copyBtn.addEventListener('click', async () => {
        const replyText = replyMatch[1].replace(/^["']|["']$/g, '');
        await navigator.clipboard.writeText(replyText);
        copyBtn.textContent = 'Copied!';
        copyBtn.classList.add('copied');
        setTimeout(() => {
          copyBtn.textContent = 'Copy';
          copyBtn.classList.remove('copied');
        }, 1500);
      });
      option.appendChild(copyBtn);
      currentCard.appendChild(option);
    }
  }

  // If nothing was parsed, show raw content
  if (container.children.length === 0) {
    const card = document.createElement('div');
    card.className = 'ai-result-card';

    const option = document.createElement('div');
    option.className = 'ai-reply-option';

    const text = document.createElement('div');
    text.className = 'ai-reply-text';
    text.textContent = content;
    option.appendChild(text);

    const copyBtn = document.createElement('button');
    copyBtn.className = 'ai-copy-btn';
    copyBtn.textContent = 'Copy';
    copyBtn.addEventListener('click', async () => {
      await navigator.clipboard.writeText(content);
      copyBtn.textContent = 'Copied!';
      copyBtn.classList.add('copied');
      setTimeout(() => {
        copyBtn.textContent = 'Copy';
        copyBtn.classList.remove('copied');
      }, 1500);
    });
    option.appendChild(copyBtn);
    card.appendChild(option);
    container.appendChild(card);
  }
}

async function loadAIView() {
  await loadAISettings();
  // Auto-load recent tweets
  const tweets = await sendMessage({ type: 'GET_RECENT_TWEETS', limit: 50 });
  renderAITweetList(tweets || []);
}

// ==================== Init ====================

async function reloadAll() {
  selectedUser = null;
  selectedUserData = null;
  hideUserContext();

  // Load initial view
  showView('home');
}

document.addEventListener('DOMContentLoaded', reloadAll);
