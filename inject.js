(function() {
    'use strict';
    // Debug mode: set to true to enable detailed logging
    const DEBUG = false;

    const channelHandleCache = new Map();
    let displayMode = 'both'; // 'both', 'name', 'handle'

    // Listen for display mode changes
    window.addEventListener('message', (event) => {
        if (event.source !== window) return;
        if (event.data.type === 'displayModeChanged') {
            displayMode = event.data.mode;
            if (DEBUG) console.log(`[YT Handle Enhancer] Display mode changed to: ${displayMode}`);
            // Update all existing messages
            updateAllMessages();
        }
    });

    // Load initial display mode from storage
    window.postMessage({ type: 'getDisplayMode' }, '*');

    const fetchHandle = async (channelId) => {
        if (DEBUG) console.log(`[YT Handle Enhancer] Fetching RSS feed for: ${channelId}`);
        try {
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

        } catch (error) {
            console.error('[YT Handle Enhancer] Failed to fetch RSS feed:', error);
        }
        return null;
    };

    const updateAuthorName = (authorChip, authorName, handle) => {
        const authorNameElement = authorChip.querySelector('#author-name');
        if (authorNameElement) {
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
        }
    };

    const updateAllMessages = () => {
        const messageSelectors = [
            'yt-live-chat-text-message-renderer',
            'yt-live-chat-paid-message-renderer',
            'yt-live-chat-membership-item-renderer',
            'yt-live-chat-paid-sticker-renderer'
        ];

        messageSelectors.forEach(selector => {
            document.querySelectorAll(selector).forEach(node => {
                const authorChip = node.querySelector('yt-live-chat-author-chip');
                if (authorChip && authorChip.dataset.originalName) {
                    const authorName = authorChip.dataset.originalName;
                    const handle = authorChip.dataset.channelHandle;
                    updateAuthorName(authorChip, authorName, handle);
                }
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
                updateAuthorName(authorChip, authorName, handle);
            }
        } else {
            channelHandleCache.set(channelId, null); // Mark as pending to avoid refetching
            const handle = await fetchHandle(channelId);
            if (handle) {
                channelHandleCache.set(channelId, handle);

                // Find all messages from the same author (including the current one) and update them
                const selectors = [
                    'yt-live-chat-text-message-renderer',
                    'yt-live-chat-paid-message-renderer',
                    'yt-live-chat-membership-item-renderer',
                    'yt-live-chat-paid-sticker-renderer'
                ];

                selectors.forEach(selector => {
                    document.querySelectorAll(selector).forEach(n => {
                        const d = n.__data || n.data;
                        if (d && d.authorExternalChannelId === channelId) {
                            const c = n.querySelector('yt-live-chat-author-chip');
                            if (c) {
                                updateAuthorName(c, d.authorName.simpleText, handle);
                            }
                        }
                    });
                });
            }
        }
    };

    const observer = new MutationObserver((mutations) => {
        const messageSelectors = [
            'yt-live-chat-text-message-renderer',
            'yt-live-chat-paid-message-renderer',
            'yt-live-chat-membership-item-renderer',
            'yt-live-chat-paid-sticker-renderer'
        ];

        for (const mutation of mutations) {
            for (const node of mutation.addedNodes) {
                if (node.nodeType !== 1) continue;

                // Check if the node itself matches any of the message types
                for (const selector of messageSelectors) {
                    if (node.matches(selector)) {
                        processMessageNode(node);
                        break;
                    }
                }

                // Check for message nodes within the added node
                messageSelectors.forEach(selector => {
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
            const messageSelectors = [
                'yt-live-chat-text-message-renderer',
                'yt-live-chat-paid-message-renderer',
                'yt-live-chat-membership-item-renderer',
                'yt-live-chat-paid-sticker-renderer'
            ];
            messageSelectors.forEach(selector => {
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

    // Initial check, in case the chat is already there
    if (!findChatAndStart()) {
        if (DEBUG) console.log('[YT Handle Enhancer] Waiting for chat app...');
        // If not, wait for it to be added to the DOM
        bodyObserver.observe(document.body, { childList: true, subtree: true });
    }
})();
