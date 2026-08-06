(function() {
    'use strict';
    // Debug mode: set to true to enable detailed logging
    const DEBUG = false;

    const channelHandleCache = new Map();
    const nicknameCache = new Map();
    let displayMode = 'both'; // 'both', 'name', 'handle'
    const CACHE_DURATION = 7 * 24 * 60 * 60 * 1000; // 1 week in milliseconds

    const MESSAGE_SELECTORS = [
        'yt-live-chat-text-message-renderer',
        'yt-live-chat-paid-message-renderer',
        'yt-live-chat-membership-item-renderer',
        'yt-live-chat-paid-sticker-renderer'
    ];

    let filterMode = 'all';
    let allowList = {};
    let blockList = {};
    let broadcasterId = null;
    let conversionEnabled = false;
    let observing = false;
    let resourcesLoaded = false;

    // Listen for display mode changes and cache clear
    window.addEventListener('message', (event) => {
        if (event.source !== window) return;
        if (event.data.type === 'displayModeChanged') {
            displayMode = event.data.mode;
            if (DEBUG) console.log(`[YT Handle Enhancer] Display mode changed to: ${displayMode}`);
            // Update all existing messages
            updateAllMessages();
        }
        if (event.data.type === 'clearCache') {
            channelHandleCache.clear();
            if (DEBUG) console.log('[YT Handle Enhancer] Cache cleared');
        }
        if (event.data.type === 'nicknamesLoaded') {
            const nicknames = event.data.nicknames || {};
            nicknameCache.clear();
            Object.entries(nicknames).forEach(([channelId, nickname]) => {
                nicknameCache.set(channelId, nickname);
            });
            if (DEBUG) console.log(`[YT Handle Enhancer] Loaded ${nicknameCache.size} nicknames`);
            updateAllMessages();
        }
        if (event.data.type === 'filterSettingsChanged') {
            requestFilterSettings().then(applyFilter);
        }
    });

    // Load cache from chrome.storage.local
    const loadCache = async () => {
        return new Promise((resolve) => {
            window.postMessage({ type: 'loadCache' }, '*');
            const handler = (event) => {
                if (event.source !== window) return;
                if (event.data.type === 'cacheLoaded') {
                    window.removeEventListener('message', handler);
                    const cache = event.data.cache || {};
                    const now = Date.now();
                    // Load valid cache entries
                    Object.entries(cache).forEach(([channelId, entry]) => {
                        if (entry.timestamp && (now - entry.timestamp) < CACHE_DURATION) {
                            channelHandleCache.set(channelId, entry.title);
                        }
                    });
                    if (DEBUG) console.log(`[YT Handle Enhancer] Loaded ${channelHandleCache.size} cached entries`);
                    resolve();
                }
            };
            window.addEventListener('message', handler);
            setTimeout(() => {
                window.removeEventListener('message', handler);
                resolve();
            }, 1000);
        });
    };

    // Save cache entry
    const saveCacheEntry = (channelId, title) => {
        window.postMessage({
            type: 'saveCache',
            channelId: channelId,
            title: title,
            timestamp: Date.now()
        }, '*');
    };

    // Load filter settings from chrome.storage.local
    const requestFilterSettings = () => {
        return new Promise((resolve) => {
            const handler = (event) => {
                if (event.source !== window) return;
                if (event.data.type === 'filterSettingsLoaded') {
                    window.removeEventListener('message', handler);
                    filterMode = event.data.filterMode || 'all';
                    allowList = event.data.allowList || {};
                    blockList = event.data.blockList || {};
                    resolve();
                }
            };
            window.addEventListener('message', handler);
            window.postMessage({ type: 'getFilterSettings' }, '*');
            setTimeout(() => {
                window.removeEventListener('message', handler);
                resolve();
            }, 1000);
        });
    };

    const getVideoId = () => {
        // A same-origin parent's location always reflects the video being watched,
        // even after an SPA navigation that left this frame in place
        try {
            if (window.parent !== window) {
                const v = new URLSearchParams(window.parent.location.search).get('v');
                if (v) return v;
                const studio = window.parent.location.pathname.match(/\/video\/([^/]+)\//);
                if (studio) return studio[1];
            }
        } catch {
            // Cross-origin; fall through
        }

        const own = new URLSearchParams(window.location.search).get('v');
        if (own) return own;

        if (!document.referrer) return null;
        try {
            const ref = new URL(document.referrer);
            const v = ref.searchParams.get('v');
            if (v) return v;
            const studio = ref.pathname.match(/\/video\/([^/]+)\//);
            if (studio) return studio[1];
        } catch {
            return null;
        }
        return null;
    };

    const resolveBroadcaster = async () => {
        const videoId = getVideoId();

        // The parent frame holds the player data on a normal watch page, but YouTube
        // leaves it pointing at the previous video after an SPA navigation, so only
        // trust it when it describes the video we are actually watching
        try {
            const host = window.parent !== window ? window.parent : window;
            const details = host.ytInitialPlayerResponse?.videoDetails;
            if (details?.channelId && (!videoId || details.videoId === videoId)) {
                return {
                    channelId: details.channelId,
                    title: details.author || '',
                    videoId: details.videoId || videoId
                };
            }
        } catch {
            // Cross-origin or not available; fall through
        }

        if (!videoId) return null;

        return new Promise((resolve) => {
            const messageId = `owner_${videoId}_${Date.now()}`;
            const handler = (event) => {
                if (event.source !== window) return;
                if (event.data.type === 'videoOwnerResolved' && event.data.messageId === messageId) {
                    window.removeEventListener('message', handler);
                    resolve(event.data.success
                        ? { channelId: event.data.channelId, title: event.data.title || '', videoId: videoId }
                        : null);
                }
            };
            window.addEventListener('message', handler);
            window.postMessage({
                type: 'resolveVideoOwner',
                videoId: videoId,
                messageId: messageId
            }, '*');

            setTimeout(() => {
                window.removeEventListener('message', handler);
                resolve(null);
            }, 5000);
        });
    };

    const fetchHandle = async (channelId) => {
        if (DEBUG) console.log(`[YT Handle Enhancer] Fetching RSS feed for: ${channelId}`);
        try {
            // Check if we're on studio.youtube.com (CORS restriction)
            const isStudio = window.location.hostname === 'studio.youtube.com';

            if (isStudio) {
                // Use message passing to content script to bypass CORS
                return new Promise((resolve) => {
                    const messageId = `fetch_${channelId}_${Date.now()}`;
                    const handler = (event) => {
                        if (event.source !== window) return;
                        if (event.data.type === 'rssFetchResponse' && event.data.messageId === messageId) {
                            window.removeEventListener('message', handler);
                            if (event.data.success && event.data.title) {
                                if (DEBUG) console.log(`[YT Handle Enhancer] Found channel title: ${event.data.title}`);
                                resolve(event.data.title);
                            } else {
                                console.error(`[YT Handle Enhancer] RSS Feed fetch failed`);
                                resolve(null);
                            }
                        }
                    };
                    window.addEventListener('message', handler);
                    window.postMessage({
                        type: 'fetchRSS',
                        channelId: channelId,
                        messageId: messageId
                    }, '*');

                    // Timeout after 5 seconds
                    setTimeout(() => {
                        window.removeEventListener('message', handler);
                        resolve(null);
                    }, 5000);
                });
            } else {
                // Direct fetch for www.youtube.com
                const response = await fetch(`https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`);
                if (!response.ok) {
                    console.error(`[YT Handle Enhancer] RSS Feed fetch failed with status: ${response.status}`);
                    return null;
                }

                const text = await response.text();

                // Extract the <title> tag content
                const titleMatch = text.match(/<title>([^<]+)<\/title>/);

                if (titleMatch && titleMatch[1]) {
                    const channelTitle = titleMatch[1];
                    if (DEBUG) console.log(`[YT Handle Enhancer] Found channel title: ${channelTitle}`);
                    return channelTitle; // Returning the title instead of the handle
                }

                if (DEBUG) console.warn(`[YT Handle Enhancer] Could not find <title> in RSS feed for ${channelId}`);
                return null;
            }
        } catch (error) {
            console.error('[YT Handle Enhancer] Failed to fetch RSS feed:', error);
        }
        return null;
    };

    const updateAuthorName = (authorChip, authorName, handle, channelId) => {
        const authorNameElement = authorChip.querySelector('#author-name');
        if (authorNameElement) {
            // Check for nickname first
            const nickname = nicknameCache.get(channelId);
            if (nickname) {
                if (DEBUG) console.log(`[YT Handle Enhancer] Using nickname: ${nickname} for ${authorName}`);
                authorNameElement.textContent = nickname;
                authorChip.dataset.handleModified = 'true';
                authorChip.dataset.originalName = authorName;
                authorChip.dataset.channelHandle = handle || '';
                authorChip.dataset.channelId = channelId;
                return;
            }

            let displayText;
            switch (displayMode) {
                case 'name':
                    displayText = handle || authorName;
                    break;
                case 'handle':
                    displayText = authorName;
                    break;
                case 'both':
                default:
                    displayText = handle ? `${handle} (${authorName})` : authorName;
                    break;
            }

            if (DEBUG) console.log(`[YT Handle Enhancer] Updating: ${authorName} -> ${displayText}`);
            authorNameElement.textContent = displayText;
            authorChip.dataset.handleModified = 'true';
            authorChip.dataset.originalName = authorName;
            authorChip.dataset.channelHandle = handle || '';
            authorChip.dataset.channelId = channelId;
        }
    };

    const updateAllMessages = () => {
        MESSAGE_SELECTORS.forEach(selector => {
            document.querySelectorAll(selector).forEach(node => {
                const authorChip = node.querySelector('yt-live-chat-author-chip');
                if (authorChip && authorChip.dataset.originalName) {
                    const authorName = authorChip.dataset.originalName;
                    const handle = authorChip.dataset.channelHandle;
                    const channelId = authorChip.dataset.channelId;
                    updateAuthorName(authorChip, authorName, handle, channelId);
                }
            });
        });
    };

    const restoreAllMessages = () => {
        MESSAGE_SELECTORS.forEach(selector => {
            document.querySelectorAll(selector).forEach(node => {
                const authorChip = node.querySelector('yt-live-chat-author-chip');
                if (!authorChip || !authorChip.dataset.originalName) return;

                const authorNameElement = authorChip.querySelector('#author-name');
                if (authorNameElement) {
                    authorNameElement.textContent = authorChip.dataset.originalName;
                }
                delete authorChip.dataset.handleModified;
            });
        });
    };

    const processMessageNode = async (node) => {
        // Check if it's a text message or paid message (Super Chat, Super Sticker, membership)
        const isTextMessage = node.matches('yt-live-chat-text-message-renderer');
        const isPaidMessage = node.matches('yt-live-chat-paid-message-renderer');
        const isMembershipItem = node.matches('yt-live-chat-membership-item-renderer');
        const isPaidSticker = node.matches('yt-live-chat-paid-sticker-renderer');

        if (!isTextMessage && !isPaidMessage && !isMembershipItem && !isPaidSticker) {
            return;
        }

        const authorChip = node.querySelector('yt-live-chat-author-chip');
        if (!authorChip) {
            // This can happen with system messages, so not necessarily an error.
            return;
        }
        if (authorChip.dataset.handleModified) {
            return; // Already processed
        }

        const data = node.__data || node.data;
        if (!data) {
            if (DEBUG) console.warn('[YT Handle Enhancer] No __data or data property found on message node.');
            return;
        }

        const authorName = data.authorName?.simpleText;
        const channelId = data.authorExternalChannelId;

        if(!authorName || !channelId) {
            if (DEBUG) console.warn('[YT Handle Enhancer] Could not find authorName or channelId in data object.');
            return;
        }

        if (DEBUG) console.log(`[YT Handle Enhancer] Processing: ${authorName} (${isPaidMessage ? 'Super Chat' : isTextMessage ? 'Text' : isMembershipItem ? 'Membership' : 'Sticker'})`);

        if (channelHandleCache.has(channelId)) {
            const handle = channelHandleCache.get(channelId);
            if (handle) {
                updateAuthorName(authorChip, authorName, handle, channelId);
            }
        } else {
            channelHandleCache.set(channelId, null); // Mark as pending to avoid refetching
            const handle = await fetchHandle(channelId);
            if (handle) {
                channelHandleCache.set(channelId, handle);
                saveCacheEntry(channelId, handle);

                // Find all messages from the same author (including the current one) and update them
                MESSAGE_SELECTORS.forEach(selector => {
                    document.querySelectorAll(selector).forEach(n => {
                        const d = n.__data || n.data;
                        if (d && d.authorExternalChannelId === channelId) {
                            const c = n.querySelector('yt-live-chat-author-chip');
                            if (c) {
                                updateAuthorName(c, d.authorName.simpleText, handle, channelId);
                            }
                        }
                    });
                });
            }
        }
    };

    const observer = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
            for (const node of mutation.addedNodes) {
                if (node.nodeType !== 1) continue;

                // Check if the node itself matches any of the message types
                for (const selector of MESSAGE_SELECTORS) {
                    if (node.matches(selector)) {
                        processMessageNode(node);
                        break;
                    }
                }

                // Check for message nodes within the added node
                MESSAGE_SELECTORS.forEach(selector => {
                    node.querySelectorAll(selector).forEach(processMessageNode);
                });
            }
        }
    });

    const findChatAndStart = () => {
        const chat = document.querySelector('yt-live-chat-app');
        if (chat) {
            if (DEBUG) console.log('[YT Handle Enhancer] Chat app found. Starting observer.');
            // Process existing messages first (all types)
            MESSAGE_SELECTORS.forEach(selector => {
                chat.querySelectorAll(selector).forEach(processMessageNode);
            });
            // Then observe for new ones
            observer.observe(chat, { childList: true, subtree: true });
            return true;
        }
        return false;
    };

    const bodyObserver = new MutationObserver((mutations, obs) => {
        if (findChatAndStart()) {
            if (DEBUG) console.log('[YT Handle Enhancer] Chat app initialized.');
            obs.disconnect(); // We found the chat, no need to observe the whole body anymore
        }
    });

    const shouldConvert = () => {
        switch (filterMode) {
            case 'allow':
                return !!broadcasterId && !!allowList[broadcasterId];
            case 'block':
                return !broadcasterId || !blockList[broadcasterId];
            case 'all':
            default:
                return true;
        }
    };

    const startWatching = () => {
        if (observing) return;
        observing = true;
        if (!findChatAndStart()) {
            if (DEBUG) console.log('[YT Handle Enhancer] Waiting for chat app...');
            bodyObserver.observe(document.body, { childList: true, subtree: true });
        }
    };

    const stopWatching = () => {
        observer.disconnect();
        bodyObserver.disconnect();
        observing = false;
        restoreAllMessages();
    };

    const applyFilter = async () => {
        const enabled = shouldConvert();
        if (enabled === conversionEnabled) return;
        conversionEnabled = enabled;

        if (!enabled) {
            if (DEBUG) console.log('[YT Handle Enhancer] Conversion disabled for this broadcaster');
            stopWatching();
            return;
        }

        if (!resourcesLoaded) {
            resourcesLoaded = true;
            window.postMessage({ type: 'getDisplayMode' }, '*');
            window.postMessage({ type: 'loadNicknames' }, '*');
            await loadCache();
        }
        startWatching();
    };

    const init = async () => {
        await requestFilterSettings();

        const broadcaster = await resolveBroadcaster();
        if (broadcaster) {
            broadcasterId = broadcaster.channelId;
            window.postMessage({
                type: 'broadcasterDetected',
                channelId: broadcaster.channelId,
                title: broadcaster.title,
                videoId: broadcaster.videoId || ''
            }, '*');
            if (DEBUG) console.log(`[YT Handle Enhancer] Broadcaster: ${broadcaster.title} (${broadcaster.channelId})`);
        } else if (DEBUG) {
            console.log('[YT Handle Enhancer] Broadcaster could not be resolved');
        }

        await applyFilter();
    };

    init();
})();
