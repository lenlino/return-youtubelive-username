document.addEventListener('DOMContentLoaded', async () => {
    // Apply localization
    document.querySelectorAll('[data-i18n]').forEach(element => {
        const key = element.getAttribute('data-i18n');
        const message = chrome.i18n.getMessage(key);
        if (message) {
            element.textContent = message;
        }
    });

    // Display settings
    const radioButtons = document.querySelectorAll('input[name="displayMode"]');
    const displayStatus = document.getElementById('displayStatus');

    // Load saved settings
    const result = await chrome.storage.sync.get({ displayMode: 'both' });
    const savedMode = result.displayMode;

    radioButtons.forEach(radio => {
        if (radio.value === savedMode) {
            radio.checked = true;
        }
    });

    // Save settings when changed
    radioButtons.forEach(radio => {
        radio.addEventListener('change', async (e) => {
            const mode = e.target.value;
            await chrome.storage.sync.set({ displayMode: mode });

            displayStatus.textContent = chrome.i18n.getMessage('settingsSaved');
            displayStatus.classList.add('show');

            // Reload all YouTube tabs to apply new settings
            const youtubeTabs = await chrome.tabs.query({ url: 'https://www.youtube.com/*' });
            const studioTabs = await chrome.tabs.query({ url: 'https://studio.youtube.com/*' });
            const allTabs = [...youtubeTabs, ...studioTabs];
            allTabs.forEach(tab => {
                chrome.tabs.reload(tab.id).catch(() => {});
            });

            setTimeout(() => {
                displayStatus.classList.remove('show');
            }, 2000);
        });
    });

    // Conversion target settings
    const filterRadios = document.querySelectorAll('input[name="filterMode"]');
    const broadcasterName = document.getElementById('broadcasterName');
    const toggleBtn = document.getElementById('toggleBroadcaster');

    const FILTER_DEFAULTS = { filterMode: 'all', allowList: {}, blockList: {} };

    let broadcaster = null;

    const notifyFilterChanged = async () => {
        const youtubeTabs = await chrome.tabs.query({ url: 'https://www.youtube.com/*' });
        const studioTabs = await chrome.tabs.query({ url: 'https://studio.youtube.com/*' });
        [...youtubeTabs, ...studioTabs].forEach(tab => {
            chrome.tabs.sendMessage(tab.id, { type: 'filterSettingsChanged' }).catch(() => {});
        });
    };

    const renderBroadcaster = async () => {
        const stored = await chrome.storage.local.get(FILTER_DEFAULTS);

        if (!broadcaster) {
            broadcasterName.textContent = chrome.i18n.getMessage('broadcasterNotDetected');
            toggleBtn.textContent = chrome.i18n.getMessage('addToList');
            toggleBtn.classList.remove('registered');
            toggleBtn.disabled = true;
            return;
        }

        broadcasterName.textContent = broadcaster.title || broadcaster.channelId;

        if (stored.filterMode === 'all') {
            toggleBtn.textContent = chrome.i18n.getMessage('addToList');
            toggleBtn.classList.remove('registered');
            toggleBtn.disabled = true;
            return;
        }

        const list = stored.filterMode === 'allow' ? stored.allowList : stored.blockList;
        const registered = list[broadcaster.channelId] !== undefined;
        toggleBtn.textContent = chrome.i18n.getMessage(registered ? 'removeFromList' : 'addToList');
        toggleBtn.classList.toggle('registered', registered);
        toggleBtn.disabled = false;
    };

    toggleBtn.addEventListener('click', async () => {
        if (!broadcaster) return;

        const stored = await chrome.storage.local.get(FILTER_DEFAULTS);
        if (stored.filterMode === 'all') return;

        const key = stored.filterMode === 'allow' ? 'allowList' : 'blockList';
        const list = stored[key];

        if (list[broadcaster.channelId] !== undefined) {
            delete list[broadcaster.channelId];
        } else {
            list[broadcaster.channelId] = broadcaster.title || broadcaster.channelId;
        }

        await chrome.storage.local.set({ [key]: list });
        await notifyFilterChanged();
        await renderBroadcaster();
    });

    const filterStored = await chrome.storage.local.get(FILTER_DEFAULTS);
    filterRadios.forEach(radio => {
        radio.checked = radio.value === filterStored.filterMode;
        radio.addEventListener('change', async (e) => {
            await chrome.storage.local.set({ filterMode: e.target.value });
            await notifyFilterChanged();
            await renderBroadcaster();
        });
    });

    const videoIdFromUrl = (url) => {
        try {
            const parsed = new URL(url);
            const v = parsed.searchParams.get('v');
            if (v) return v;
            const studio = parsed.pathname.match(/\/video\/([^/]+)\//);
            if (studio) return studio[1];
        } catch {
            return null;
        }
        return null;
    };

    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (activeTab) {
        const session = await chrome.storage.session.get(['broadcasters']);
        const stored = (session.broadcasters || {})[activeTab.id] || null;
        // Drop the entry if the tab has since moved to another video
        const currentVideoId = videoIdFromUrl(activeTab.url || '');
        const isStale = stored && stored.videoId && currentVideoId && stored.videoId !== currentVideoId;
        broadcaster = isStale ? null : stored;
    }
    await renderBroadcaster();

    // Open settings page
    const openSettingsBtn = document.getElementById('openSettings');
    openSettingsBtn.addEventListener('click', () => {
        chrome.tabs.create({ url: chrome.runtime.getURL('settings.html') });
    });
});
