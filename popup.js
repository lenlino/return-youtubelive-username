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

    // Open settings page
    const openSettingsBtn = document.getElementById('openSettings');
    openSettingsBtn.addEventListener('click', () => {
        chrome.tabs.create({ url: chrome.runtime.getURL('settings.html') });
    });
});
