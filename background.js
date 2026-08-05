// Background service worker for handling RSS feed fetches
// This bypasses CORS restrictions for studio.youtube.com

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'fetchRSS') {
        const { channelId } = message;

        fetch(`https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`)
            .then(response => {
                if (!response.ok) {
                    sendResponse({ success: false });
                    return;
                }
                return response.text();
            })
            .then(text => {
                if (!text) return;

                const titleMatch = text.match(/<title>([^<]+)<\/title>/);
                if (titleMatch && titleMatch[1]) {
                    sendResponse({
                        success: true,
                        title: titleMatch[1]
                    });
                } else {
                    sendResponse({ success: false });
                }
            })
            .catch(error => {
                console.error('[YT Handle Enhancer] Background fetch failed:', error);
                sendResponse({ success: false });
            });

        return true; // Keep the message channel open for async response
    }

    if (message.type === 'fetchVideoOwner') {
        const { videoId } = message;

        fetch(`https://www.youtube.com/watch?v=${videoId}`)
            .then(response => response.ok ? response.text() : null)
            .then(text => {
                if (!text) {
                    sendResponse({ success: false });
                    return;
                }

                // Scope the search to videoDetails; channelId appears elsewhere too
                const detailsIndex = text.indexOf('"videoDetails"');
                const scope = detailsIndex >= 0
                    ? text.slice(detailsIndex, detailsIndex + 4000)
                    : text;

                const idMatch = scope.match(/"channelId":"(UC[\w-]{22})"/);
                if (!idMatch) {
                    sendResponse({ success: false });
                    return;
                }

                const nameMatch = scope.match(/"author":"((?:[^"\\]|\\.)*)"/);
                let title = '';
                if (nameMatch) {
                    try {
                        title = JSON.parse(`"${nameMatch[1]}"`);
                    } catch {
                        title = '';
                    }
                }

                sendResponse({ success: true, channelId: idMatch[1], title });
            })
            .catch(error => {
                console.error('[YT Handle Enhancer] Video owner fetch failed:', error);
                sendResponse({ success: false });
            });

        return true; // Keep the message channel open for async response
    }

    if (message.type === 'broadcasterDetected') {
        const tabId = sender.tab?.id;
        if (tabId === undefined) return;

        chrome.storage.session.get(['broadcasters']).then((result) => {
            const broadcasters = result.broadcasters || {};
            broadcasters[tabId] = {
                channelId: message.channelId,
                title: message.title || ''
            };
            chrome.storage.session.set({ broadcasters });
        });
    }
});

// Drop broadcaster info when its tab goes away
chrome.tabs.onRemoved.addListener(async (tabId) => {
    const result = await chrome.storage.session.get(['broadcasters']);
    const broadcasters = result.broadcasters || {};
    if (broadcasters[tabId] === undefined) return;

    delete broadcasters[tabId];
    await chrome.storage.session.set({ broadcasters });
});
