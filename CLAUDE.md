# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

X-Vault is a Chrome Extension (Manifest V3) that passively captures tweets from Twitter/X as you browse. All data is stored locally in IndexedDB. Users can search, organize, and export tweets to LLMs for analysis.

**Stack:** Vanilla JavaScript (ES6 modules), no frameworks, no build tools, no package manager.

## Development Workflow

There is no build step, test runner, or linter. To develop:

1. Load the extension unpacked in `chrome://extensions` (Developer mode)
2. Edit JS/HTML/CSS files directly
3. Click the reload icon on the extension card in `chrome://extensions` to pick up changes

Debug with browser DevTools:
- Content script: page console on twitter.com/x.com
- Service worker: `chrome://extensions` → X-Vault → "Inspect views: service worker"
- Dashboard: open DevTools on the dashboard tab

## Architecture

Three-layer Chrome Extension architecture communicating via `chrome.runtime.sendMessage()`:

```
content.js (on X pages) → background.js (service worker) → db.js (IndexedDB)
                                ↑
                          dashboard.js (UI)
```

**`content.js`** — Content script injected on twitter.com/x.com. Uses MutationObserver (300ms debounce) to detect new tweets in the DOM, extracts metadata (text, handle, timestamps, like/impression counts), and sends `STORE_TWEET` messages to the background worker. Renders a floating button on profile pages for block/status indication.

**`background.js`** — Service worker that acts as a message router. Receives all messages from both `content.js` and `dashboard.js`, delegates to `db.js` for persistence, and updates the extension badge count. All message types are `UPPERCASE_WITH_UNDERSCORES` constants (e.g., `STORE_TWEET`, `GET_USERS`, `SEARCH_TWEETS`, `BLOCK_USER`).

**`db.js`** — IndexedDB abstraction layer. Database `TwitterScrapeDB` at version 5 with five object stores:
- `tweets` (keyPath: `tweetId`) — indexes: `byUser`, `byTimestamp`, `byUserAndTime`
- `users` (keyPath: `handle`) — index: `bySortOrder` ([starred, tweetCount])
- `blockedUsers` (keyPath: `handle`) — O(1) block checks
- `settings` (keyPath: `key`) — home feed settings, starred users
- `searchIndex` (keyPath: `word`) — inverted index mapping words to tweetId arrays

Schema migrations are handled in `onupgradeneeded` with version checks (V2→settings, V3→blockedUsers store, V4→sort index, V5→search index).

**`dashboard.html` / `dashboard.js` / `dashboard.css`** — Full dashboard UI with user sidebar, tweet list, search, user notes, star/block actions, export (Markdown/JSON/Plain Text), and LLM prompt templates. Settings modal handles capture config, data cleanup, blocked users management, and database import/export.

## Key Performance Patterns

- Blocked user checks use a dedicated object store for O(1) lookup (not array scan)
- Tweet counts are incremented via `adjustUserTweetCount()` rather than recounted
- Search uses an inverted word index; falls back to full scan for partial matches
- Content script caches home feed settings with a 5-second TTL to minimize IPC
- Notes auto-save and search input both use 500ms/300ms debounce respectively

## Code Conventions

- Message types: `UPPERCASE_WITH_UNDERSCORES`
- Variables/functions: `camelCase`
- HTML element IDs: `kebab-case`
- Console logging prefixed with `[X-Vault]`
- User content escaped via `escapeHtml()` before DOM insertion
- Promise chains (`.then()/.catch()`) and `async/await` are both used
