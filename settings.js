document.addEventListener('DOMContentLoaded', async () => {
    // Apply localization
    document.querySelectorAll('[data-i18n]').forEach(element => {
        const key = element.getAttribute('data-i18n');
        const message = chrome.i18n.getMessage(key);
        if (message) {
            element.textContent = message;
        }
    });

    document.querySelectorAll('[data-i18n-placeholder]').forEach(element => {
        const key = element.getAttribute('data-i18n-placeholder');
        const message = chrome.i18n.getMessage(key);
        if (message) {
            element.placeholder = message;
        }
    });

    // Tab switching
    const tabButtons = document.querySelectorAll('.tab-button');
    const tabContents = document.querySelectorAll('.tab-content');

    tabButtons.forEach(button => {
        button.addEventListener('click', () => {
            const tabName = button.dataset.tab;

            // Remove active class from all buttons and contents
            tabButtons.forEach(btn => btn.classList.remove('active'));
            tabContents.forEach(content => content.classList.remove('active'));

            // Add active class to clicked button and corresponding content
            button.classList.add('active');
            document.getElementById(`${tabName}-tab`).classList.add('active');
        });
    });

    // Nickname management
    const nicknameSearch = document.getElementById('nicknameSearch');
    const nicknameList = document.getElementById('nicknameList');

    const loadNicknames = async () => {
        const cache = await chrome.storage.local.get(['channelCache', 'nicknames']);
        const channelCache = cache.channelCache || {};
        const nicknames = cache.nicknames || {};

        const channels = Object.entries(channelCache).map(([channelId, data]) => ({
            channelId,
            name: data.title,
            nickname: nicknames[channelId] || ''
        }));

        return channels;
    };

    const renderNicknameList = async (searchTerm = '') => {
        const channels = await loadNicknames();
        const filtered = channels.filter(ch =>
            ch.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
            ch.nickname.toLowerCase().includes(searchTerm.toLowerCase())
        );

        // Sort: channels with nicknames first, then alphabetically by name
        filtered.sort((a, b) => {
            if (a.nickname && !b.nickname) return -1;
            if (!a.nickname && b.nickname) return 1;
            return a.name.localeCompare(b.name);
        });

        nicknameList.innerHTML = filtered.map(ch => `
            <div class="nickname-item" data-channel-id="${ch.channelId}">
                <div class="channel-info">
                    <div class="channel-name">${ch.name}</div>
                </div>
                <input type="text" value="${ch.nickname}" placeholder="${chrome.i18n.getMessage('nicknamePlaceholder') || 'Set nickname...'}" data-channel-id="${ch.channelId}">
                <button data-channel-id="${ch.channelId}">${chrome.i18n.getMessage('removeNickname') || 'Remove'}</button>
            </div>
        `).join('');

        // Add event listeners
        nicknameList.querySelectorAll('input').forEach(input => {
            input.addEventListener('change', async (e) => {
                const channelId = e.target.dataset.channelId;
                const nickname = e.target.value.trim();

                const result = await chrome.storage.local.get(['nicknames']);
                const nicknames = result.nicknames || {};

                if (nickname) {
                    nicknames[channelId] = nickname;
                } else {
                    delete nicknames[channelId];
                }

                await chrome.storage.local.set({ nicknames });

                // Notify tabs to update
                const youtubeTabs = await chrome.tabs.query({ url: 'https://www.youtube.com/*' });
                const studioTabs = await chrome.tabs.query({ url: 'https://studio.youtube.com/*' });
                const allTabs = [...youtubeTabs, ...studioTabs];
                allTabs.forEach(tab => {
                    chrome.tabs.sendMessage(tab.id, { type: 'nicknameUpdated' }).catch(() => {});
                });
            });
        });

        nicknameList.querySelectorAll('button').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                const channelId = e.target.dataset.channelId;
                const input = nicknameList.querySelector(`input[data-channel-id="${channelId}"]`);

                const result = await chrome.storage.local.get(['nicknames']);
                const nicknames = result.nicknames || {};
                delete nicknames[channelId];

                await chrome.storage.local.set({ nicknames });
                input.value = '';

                // Notify tabs to update
                const youtubeTabs = await chrome.tabs.query({ url: 'https://www.youtube.com/*' });
                const studioTabs = await chrome.tabs.query({ url: 'https://studio.youtube.com/*' });
                const allTabs = [...youtubeTabs, ...studioTabs];
                allTabs.forEach(tab => {
                    chrome.tabs.sendMessage(tab.id, { type: 'nicknameUpdated' }).catch(() => {});
                });
            });
        });
    };

    nicknameSearch.addEventListener('input', (e) => {
        renderNicknameList(e.target.value);
    });

    // Initial render
    renderNicknameList();

    // Cache management
    const clearCacheBtn = document.getElementById('clearCache');
    const cacheStatus = document.getElementById('cacheStatus');

    clearCacheBtn.addEventListener('click', () => {
        chrome.storage.local.remove(['channelCache'], () => {
            cacheStatus.textContent = chrome.i18n.getMessage('cacheCleared');
            cacheStatus.classList.add('show');

            // Notify all tabs to clear their in-memory cache
            const youtubeTabs = chrome.tabs.query({ url: 'https://www.youtube.com/*' });
            const studioTabs = chrome.tabs.query({ url: 'https://studio.youtube.com/*' });
            Promise.all([youtubeTabs, studioTabs]).then(([yt, st]) => {
                const allTabs = [...yt, ...st];
                allTabs.forEach(tab => {
                    chrome.tabs.sendMessage(tab.id, { type: 'clearCache' }).catch(() => {});
                });
            });

            setTimeout(() => {
                cacheStatus.classList.remove('show');
            }, 2000);
        });
    });
});
