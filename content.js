(() => {
  const processedIds = new Set();
  let debounceTimer = null;
  let currentProfileHandle = null;
  let floatingBtn = null;

  // Inject styles for the captured badge and floating button
  const style = document.createElement('style');
  style.textContent = `
    .ts-captured-badge {
      position: absolute;
      top: 4px;
      right: 4px;
      width: 20px;
      height: 20px;
      z-index: 10;
      pointer-events: none;
      opacity: 0.5;
    }
    .ts-captured-badge svg {
      width: 100%;
      height: 100%;
      fill: #17bf63;
    }
    .ts-blocked-badge {
      position: absolute;
      top: 4px;
      right: 4px;
      background: #e0245e;
      color: #fff;
      font-size: 10px;
      font-weight: 600;
      font-family: -apple-system, BlinkMacSystemFont, sans-serif;
      padding: 2px 6px;
      border-radius: 4px;
      z-index: 10;
      pointer-events: none;
      opacity: 0.85;
    }
    .ts-floating-btn {
      position: relative;
      width: 56px;
      height: 56px;
      border-radius: 50%;
      background: #1DA1F2;
      border: 3px solid #fff;
      box-shadow: 0 4px 12px rgba(0,0,0,0.3);
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: transform 0.2s, box-shadow 0.2s;
    }
    .ts-floating-btn:hover {
      transform: scale(1.1);
      box-shadow: 0 6px 16px rgba(0,0,0,0.4);
    }
    .ts-floating-btn img {
      width: 50px;
      height: 50px;
      object-fit: cover;
      border-radius: 50%;
    }
    .ts-floating-btn .ts-count-badge {
      position: absolute;
      bottom: -2px;
      right: -2px;
      background: #e0245e;
      color: #fff;
      font-size: 11px;
      font-weight: 700;
      font-family: -apple-system, BlinkMacSystemFont, sans-serif;
      padding: 2px 6px;
      border-radius: 10px;
      min-width: 20px;
      text-align: center;
      box-shadow: 0 2px 4px rgba(0,0,0,0.2);
      border: 2px solid #fff;
    }
    .ts-floating-btn .ts-default-icon {
      width: 28px;
      height: 28px;
      fill: #fff;
    }
    .ts-floating-container {
      position: fixed;
      top: 80px;
      right: 20px;
      display: flex;
      flex-direction: column;
      align-items: flex-end;
      gap: 8px;
      z-index: 9999;
    }
    .ts-block-btn {
      width: 32px;
      height: 32px;
      border-radius: 50%;
      background: #e0245e;
      border: 2px solid #fff;
      box-shadow: 0 2px 8px rgba(0,0,0,0.3);
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: transform 0.2s, box-shadow 0.2s, background 0.2s;
    }
    .ts-block-btn:hover {
      transform: scale(1.1);
      box-shadow: 0 4px 12px rgba(0,0,0,0.4);
      background: #c5203e;
    }
    .ts-block-btn.blocked {
      background: #17bf63;
    }
    .ts-block-btn.blocked:hover {
      background: #14a857;
    }
    .ts-block-btn svg {
      width: 16px;
      height: 16px;
      fill: #fff;
    }
  `;
  document.head.appendChild(style);

  // Create floating button
  let floatingContainer = null;
  let blockBtn = null;
  let isCurrentUserBlocked = false;

  function createFloatingButton() {
    if (floatingContainer) return;

    // Create container
    floatingContainer = document.createElement('div');
    floatingContainer.className = 'ts-floating-container';

    // Create main button
    floatingBtn = document.createElement('div');
    floatingBtn.className = 'ts-floating-btn';
    floatingBtn.title = 'X-Vault - Click to open';
    floatingBtn.innerHTML = `
      <svg class="ts-default-icon" viewBox="0 0 24 24">
        <path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-7 14l-5-5 1.41-1.41L12 14.17l4.59-4.59L18 11l-6 6z"/>
      </svg>
      <div class="ts-count-badge">0</div>
    `;

    floatingBtn.addEventListener('click', () => {
      // Send message to open popup - this will trigger background to open popup
      chrome.runtime.sendMessage({ type: 'OPEN_POPUP' }).catch(() => { });
    });

    // Create block button
    blockBtn = document.createElement('div');
    blockBtn.className = 'ts-block-btn';
    blockBtn.title = 'Block this user from capture';
    blockBtn.innerHTML = `
      <svg viewBox="0 0 24 24">
        <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/>
      </svg>
    `;

    blockBtn.addEventListener('click', async () => {
      if (!currentProfileHandle) return;

      try {
        if (isCurrentUserBlocked) {
          // Unblock user
          await chrome.runtime.sendMessage({ type: 'UNBLOCK_USER', handle: currentProfileHandle });
          isCurrentUserBlocked = false;
          blockBtn.classList.remove('blocked');
          blockBtn.title = 'Block this user from capture';
          blockBtn.innerHTML = `
            <svg viewBox="0 0 24 24">
              <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/>
            </svg>
          `;
        } else {
          // Block user
          await chrome.runtime.sendMessage({ type: 'BLOCK_USER', handle: currentProfileHandle });
          isCurrentUserBlocked = true;
          blockBtn.classList.add('blocked');
          blockBtn.title = 'Unblock this user';
          blockBtn.innerHTML = `
            <svg viewBox="0 0 24 24">
              <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/>
            </svg>
          `;
          // Update count badge to 0 since user is now blocked
          const countBadge = floatingBtn.querySelector('.ts-count-badge');
          if (countBadge) countBadge.textContent = '0';
        }
      } catch (e) {
        console.error('[X-Vault] Error toggling block:', e);
      }
    });

    floatingContainer.appendChild(floatingBtn);
    floatingContainer.appendChild(blockBtn);
    document.body.appendChild(floatingContainer);
  }

  // Update floating button with user info
  async function updateFloatingButton(handle, avatarUrl) {
    if (!floatingBtn) createFloatingButton();

    currentProfileHandle = handle;

    // Update avatar
    if (avatarUrl) {
      const existingImg = floatingBtn.querySelector('img');
      const existingSvg = floatingBtn.querySelector('svg');

      if (existingImg) {
        existingImg.src = avatarUrl;
      } else {
        if (existingSvg) existingSvg.remove();
        const img = document.createElement('img');
        img.src = avatarUrl;
        img.alt = `@${handle}`;
        floatingBtn.insertBefore(img, floatingBtn.firstChild);
      }
    }

    // Get user tweet count and check blocked status
    try {
      const [user, blockedUsers] = await Promise.all([
        chrome.runtime.sendMessage({ type: 'GET_USER', handle }),
        chrome.runtime.sendMessage({ type: 'GET_BLOCKED_USERS' })
      ]);

      const countBadge = floatingBtn.querySelector('.ts-count-badge');
      if (countBadge) {
        countBadge.textContent = user?.tweetCount || 0;
      }

      // Update block button state
      isCurrentUserBlocked = blockedUsers?.includes(handle) || false;
      if (blockBtn) {
        if (isCurrentUserBlocked) {
          blockBtn.classList.add('blocked');
          blockBtn.title = 'Unblock this user';
          blockBtn.innerHTML = `
            <svg viewBox="0 0 24 24">
              <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/>
            </svg>
          `;
        } else {
          blockBtn.classList.remove('blocked');
          blockBtn.title = 'Block this user from capture';
          blockBtn.innerHTML = `
            <svg viewBox="0 0 24 24">
              <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/>
            </svg>
          `;
        }
      }
    } catch (e) {
      // Ignore errors
    }

    floatingBtn.title = `@${handle} - Click to open X-Vault`;
  }

  // Detect current profile from URL
  function detectProfileFromURL() {
    const path = window.location.pathname;
    // Match /@username or /username but not /home, /explore, /notifications, etc.
    const reserved = ['home', 'explore', 'notifications', 'messages', 'search', 'settings', 'i', 'compose'];
    const match = path.match(/^\/([a-zA-Z0-9_]+)/);

    if (match && !reserved.includes(match[1].toLowerCase())) {
      return match[1].toLowerCase();
    }
    return null;
  }

  // Extract profile avatar from page
  function getProfileAvatar() {
    // Try to get avatar from profile header
    const profileImg = document.querySelector('a[href$="/photo"] img[src*="profile_images"]');
    if (profileImg) return profileImg.src;

    // Fallback: get from first tweet by this user
    const handle = detectProfileFromURL();
    if (handle) {
      const articles = document.querySelectorAll('article[data-testid="tweet"]');
      for (const article of articles) {
        const link = article.querySelector(`a[href="/${handle}" i]`);
        if (link) {
          const img = article.querySelector('img[src*="profile_images"]');
          if (img) return img.src;
        }
      }
    }
    return null;
  }

  // Check and update profile button
  function checkProfile() {
    const handle = detectProfileFromURL();
    if (handle && handle !== currentProfileHandle) {
      const avatar = getProfileAvatar();
      updateFloatingButton(handle, avatar);
    } else if (handle && currentProfileHandle === handle) {
      // Same profile, just refresh the count
      refreshButtonCount();
    }
  }

  // Refresh just the count
  async function refreshButtonCount() {
    if (!currentProfileHandle || !floatingBtn) return;

    try {
      const user = await chrome.runtime.sendMessage({ type: 'GET_USER', handle: currentProfileHandle });
      const countBadge = floatingBtn.querySelector('.ts-count-badge');
      if (countBadge) {
        countBadge.textContent = user?.tweetCount || 0;
      }
    } catch (e) {
      // Ignore errors
    }
  }

  function markCaptured(article) {
    if (article.querySelector('.ts-captured-badge') || article.querySelector('.ts-blocked-badge')) return;
    article.style.position = 'relative';
    const badge = document.createElement('div');
    badge.className = 'ts-captured-badge';
    badge.innerHTML = `
      <svg viewBox="0 0 24 24">
        <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/>
      </svg>
    `;
    article.appendChild(badge);
  }

  function markBlocked(article) {
    if (article.querySelector('.ts-blocked-badge') || article.querySelector('.ts-captured-badge')) return;
    article.style.position = 'relative';
    const badge = document.createElement('div');
    badge.className = 'ts-blocked-badge';
    badge.textContent = 'BLOCKED';
    article.appendChild(badge);
  }

  function extractTweetData(article) {
    // Find the status link to get handle and tweet ID
    const statusLink = article.querySelector('a[href*="/status/"]');
    if (!statusLink) return null;

    const href = statusLink.getAttribute('href');
    const parts = href.split('/');
    const statusIdx = parts.indexOf('status');
    if (statusIdx === -1 || statusIdx < 1) return null;

    const handle = parts[statusIdx - 1].toLowerCase();
    const tweetId = parts[statusIdx + 1];
    if (!tweetId || !/^\d+$/.test(tweetId)) return null;

    // Timestamp
    const timeEl = article.querySelector('time[datetime]');
    const timestamp = timeEl ? timeEl.getAttribute('datetime') : new Date().toISOString();

    // Tweet text
    const textEl = article.querySelector('[data-testid="tweetText"]');
    const fullText = textEl ? textEl.innerText : '';

    // Display name and handle from User-Name
    const userNameEl = article.querySelector('[data-testid="User-Name"]');
    let displayName = '';
    if (userNameEl) {
      const nameLink = userNameEl.querySelector('a');
      if (nameLink) {
        // The first text node or span in the link is the display name
        const spans = nameLink.querySelectorAll('span');
        for (const span of spans) {
          const text = span.textContent.trim();
          if (text && !text.startsWith('@')) {
            displayName = text;
            break;
          }
        }
      }
    }

    // Avatar
    const avatarImg = article.querySelector('img[src*="profile_images"]');
    const avatarUrl = avatarImg ? avatarImg.getAttribute('src') : '';

    // Detect retweet
    const socialContext = article.querySelector('[data-testid="socialContext"]');
    let isRetweet = false;
    let retweetedBy = null;
    if (socialContext && socialContext.textContent.toLowerCase().includes('reposted')) {
      isRetweet = true;
      // The current page user or the name in the social context is the retweeter
      const retweeterLink = socialContext.querySelector('a[href^="/"]');
      if (retweeterLink) {
        retweetedBy = retweeterLink.getAttribute('href').replace('/', '').toLowerCase();
      }
    }

    return {
      tweetId,
      handle,
      displayName,
      fullText,
      timestamp,
      url: `https://x.com/${handle}/status/${tweetId}`,
      avatarUrl,
      capturedAt: new Date().toISOString(),
      isRetweet,
      retweetedBy
    };
  }

  // Check if we should capture on current page
  function shouldCaptureOnPage() {
    const path = window.location.pathname;

    // Always capture on specific tweet pages (/username/status/id)
    if (path.includes('/status/')) return { capture: true, isHome: false };

    // Check if we're on home page
    if (path === '/home' || path === '/' || path === '') {
      return { capture: false, isHome: true };
    }

    // Check if we're on a profile page (not a reserved route)
    const reserved = ['home', 'explore', 'notifications', 'messages', 'search', 'settings', 'i', 'compose'];
    const match = path.match(/^\/([a-zA-Z0-9_]+)/);
    if (match && !reserved.includes(match[1].toLowerCase())) {
      return { capture: true, isHome: false };
    }

    // Default: treat as home-like page
    return { capture: false, isHome: true };
  }

  async function processTweets() {
    const pageCheck = shouldCaptureOnPage();

    // If on home-like page, check the setting
    if (pageCheck.isHome) {
      try {
        const captureFromHome = await chrome.runtime.sendMessage({ type: 'GET_CAPTURE_FROM_HOME' });
        if (!captureFromHome) return; // Don't capture on home if disabled
      } catch (e) {
        return; // Can't check setting, don't capture
      }
    } else if (!pageCheck.capture) {
      return; // Don't capture on this page type
    }

    const articles = document.querySelectorAll('article[data-testid="tweet"]');
    for (const article of articles) {
      const data = extractTweetData(article);
      if (!data || processedIds.has(data.tweetId)) continue;

      processedIds.add(data.tweetId);

      chrome.runtime.sendMessage({
        type: 'STORE_TWEET',
        tweet: data
      }).then((response) => {
        if (response && response.blocked) {
          markBlocked(article);
        } else {
          markCaptured(article);
          // Refresh button count after capturing
          refreshButtonCount();
        }
      }).catch(() => {
        // Extension context may have been invalidated; ignore
      });
    }
  }

  // Listen for real-time updates from background
  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === 'TWEET_ADDED' && message.tweet.handle === currentProfileHandle) {
      refreshButtonCount();
    }
  });

  // Handle URL changes (SPA navigation)
  let lastUrl = location.href;
  const urlObserver = new MutationObserver(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      setTimeout(checkProfile, 500); // Wait for page to render
    }
  });

  // Initial setup
  createFloatingButton();
  setTimeout(checkProfile, 1000); // Initial profile check

  // Initial scan
  processTweets();

  // Observe DOM for new tweets (infinite scroll, SPA navigation)
  const observer = new MutationObserver(() => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      processTweets();
      checkProfile();
    }, 300);
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true
  });

  urlObserver.observe(document.body, {
    childList: true,
    subtree: true
  });
})();

