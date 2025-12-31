// Inject the script
const s = document.createElement('script');
s.src = chrome.runtime.getURL('inject.js');
s.onload = function() {
    this.remove();
};
(document.head || document.documentElement).appendChild(s);

// Listen for messages from popup
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'displayModeChanged') {
        // Forward the message to the injected script
        window.postMessage({
            type: 'displayModeChanged',
            mode: message.mode
        }, '*');
    }
});

// Handle requests for current display mode from injected script
window.addEventListener('message', async (event) => {
    if (event.source !== window) return;

    if (event.data.type === 'getDisplayMode') {
        // Get the current display mode from storage and send it to the injected script
        const result = await chrome.storage.sync.get({ displayMode: 'both' });
        window.postMessage({
            type: 'displayModeChanged',
            mode: result.displayMode
        }, '*');
    }

    if (event.data.type === 'fetchRSS') {
        // Handle RSS fetch request (for CORS bypass on studio.youtube.com)
        const { channelId, messageId } = event.data;

        // Use background script to bypass CORS
        chrome.runtime.sendMessage({
            type: 'fetchRSS',
            channelId: channelId
        }, (response) => {
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
    }
});
