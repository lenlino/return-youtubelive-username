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
});
