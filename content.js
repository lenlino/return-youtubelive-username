// Check if extension context is valid
function isContextValid() {
    try {
        chrome.runtime.getURL('');
        return true;
    } catch {
        return false;
    }
}

// Inject the script
const s = document.createElement('script');
s.src = chrome.runtime.getURL('inject.js');
s.onload = function() {
    this.remove();
};
(document.head || document.documentElement).appendChild(s);

// Listen for messages from popup
chrome.runtime.onMessage.addListener((message) => {
    if (!isContextValid()) return;

    if (message.type === 'displayModeChanged') {
        window.postMessage({
            type: 'displayModeChanged',
            mode: message.mode
        }, '*');
    }

    if (message.type === 'clearCache') {
        window.postMessage({ type: 'clearCache' }, '*');
    }

    if (message.type === 'nicknameUpdated') {
        window.postMessage({ type: 'loadNicknames' }, '*');
    }
});

// Handle requests for current display mode from injected script
window.addEventListener('message', async (event) => {
    if (event.source !== window || !isContextValid()) return;

    if (event.data.type === 'getDisplayMode') {
        try {
            const result = await chrome.storage.sync.get({ displayMode: 'both' });
            window.postMessage({
                type: 'displayModeChanged',
                mode: result.displayMode
            }, '*');
        } catch (error) {
            console.error('[Content Script] Error getting display mode:', error);
        }
    }

    if (event.data.type === 'loadCache') {
        try {
            const result = await chrome.storage.local.get(['channelCache']);
            window.postMessage({
                type: 'cacheLoaded',
                cache: result.channelCache || {}
            }, '*');
        } catch (error) {
            console.error('[Content Script] Error loading cache:', error);
        }
    }

    if (event.data.type === 'saveCache') {
        try {
            const { channelId, title, timestamp } = event.data;
            const result = await chrome.storage.local.get(['channelCache']);
            const cache = result.channelCache || {};
            cache[channelId] = { title, timestamp };
            await chrome.storage.local.set({ channelCache: cache });
        } catch (error) {
            console.error('[Content Script] Error saving cache:', error);
        }
    }

    if (event.data.type === 'clearCache') {
        try {
            await chrome.storage.local.remove(['channelCache']);
            window.postMessage({ type: 'cacheCleared' }, '*');
        } catch (error) {
            console.error('[Content Script] Error clearing cache:', error);
        }
    }

    if (event.data.type === 'loadNicknames') {
        try {
            const result = await chrome.storage.local.get(['nicknames']);
            window.postMessage({
                type: 'nicknamesLoaded',
                nicknames: result.nicknames || {}
            }, '*');
        } catch (error) {
            console.error('[Content Script] Error loading nicknames:', error);
        }
    }

    if (event.data.type === 'fetchRSS') {
        try {
            const { channelId, messageId } = event.data;
            chrome.runtime.sendMessage({
                type: 'fetchRSS',
                channelId: channelId
            }, (response) => {
                if (chrome.runtime.lastError) {
                    console.error('[Content Script] Runtime error:', chrome.runtime.lastError);
                    window.postMessage({
                        type: 'rssFetchResponse',
                        messageId: messageId,
                        success: false
                    }, '*');
                    return;
                }

                if (response && response.success) {
                    window.postMessage({
                        type: 'rssFetchResponse',
                        messageId: messageId,
                        success: true,
                        title: response.title
                    }, '*');
                } else {
                    window.postMessage({
                        type: 'rssFetchResponse',
                        messageId: messageId,
                        success: false
                    }, '*');
                }
            });
        } catch (error) {
            console.error('[Content Script] Error fetching RSS:', error);
        }
    }
});
