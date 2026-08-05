# 変換対象配信者フィルタ 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 視聴中の配信の配信者チャンネルを判定し、ユーザーが指定した配信でのみチャット表示名の変換を行うようにして、対象外の配信での負荷をゼロにする。

**Architecture:** `inject.js` が起動時に配信者チャンネルIDを解決し、`chrome.storage.local` に保存されたモード・リストと照合する。変換対象外なら `MutationObserver` を一切起動しない。配信者IDは、通常の視聴ページでは同一オリジンの親フレームの `ytInitialPlayerResponse` から、ポップアウトチャットや Studio では動画IDを使って background service worker が watch ページを取得して解決する。ポップアップと設定ページからモード切替とリスト編集を行い、既存の `chrome.tabs.sendMessage` 経路で開いているタブへ即時反映する。

**Tech Stack:** Chrome Extension Manifest V3、素の JavaScript（ビルドツール・パッケージマネージャ・テストランナーなし）、`chrome.storage.local` / `chrome.storage.session`、`chrome.i18n`。

## Global Constraints

- ビルド手順は存在しない。ソースを編集して `chrome://extensions` で「更新」を押すだけで反映される。
- 自動テストの仕組みは無い。各タスクの検証はブラウザ上での手動確認とする。
- 新しいパーミッションを追加しない。`storage` / `tabs` と既存の host permissions のみで実装する。
- `chrome.storage.local` を使う。既存の `nicknames` / `channelCache` と保存先を揃える。`displayMode` だけは既存どおり `chrome.storage.sync` のまま変更しない。
- ストレージキーと既定値は正確に次のとおり: `filterMode` は `'all' | 'allow' | 'block'` で既定 `'all'`、`allowList` と `blockList` は `{ [channelId]: string }` で既定 `{}`、`videoOwnerCache` は `{ [videoId]: { channelId, title, timestamp } }` で既定 `{}`。
- `videoOwnerCache` の有効期限は既存の `channelCache` と同じ 1 週間（`7 * 24 * 60 * 60 * 1000` ミリ秒）。
- 既存コードのインデントは半角スペース 4 個。これに合わせる。
- コードコメントは最小限にし、英語で書く（既存ファイルに合わせる）。
- i18n キーはキャメルケース。`_locales` 配下 6 言語すべて（`ja` `en` `es` `hi` `id` `pt`）に同じキーを追加する。`ja` を原文とする。
- チャンネル名は外部由来の文字列のため、DOM へ差し込む際は `innerHTML` ではなく `textContent` を使う。

---

## File Structure

| ファイル | 責務 | 本計画での扱い |
| --- | --- | --- |
| `background.js` | CORS 回避が必要なネットワーク取得と、タブ単位の配信者情報の保持 | 修正（Task 1） |
| `content.js` | 拡張 API とページ内スクリプトの橋渡し | 修正（Task 2） |
| `inject.js` | ページ内でのチャット監視と表示名の書き換え | 修正（Task 3） |
| `_locales/*/messages.json` | UI 文言 | 修正（Task 4） |
| `popup.html` / `popup.js` / `popup.css` | 視聴中の配信に対するワンクリック操作 | 修正（Task 5） |
| `settings.html` / `settings.js` / `settings.css` | 登録済みチャンネルの一覧管理 | 修正（Task 6） |
| `manifest.json` | バージョン | 修正（Task 7） |

新規ファイルは作らない。既存の 3 層構成（background / content / inject）をそのまま踏襲する。

---

### Task 1: background.js に配信者解決とタブ別配信者情報の保持を追加する

**Files:**
- Modify: `background.js`（既存の `chrome.runtime.onMessage` リスナー内に分岐を追加し、ファイル末尾にリスナーを 1 つ追加）

**Interfaces:**
- Consumes: なし（このタスクが最初）
- Produces:
  - メッセージ `{ type: 'fetchVideoOwner', videoId: string }` → レスポンス `{ success: true, channelId: string, title: string }` または `{ success: false }`
  - メッセージ `{ type: 'broadcasterDetected', channelId: string, title: string }` → レスポンスなし。送信元タブIDをキーに `chrome.storage.session` の `broadcasters` へ保存する
  - `chrome.storage.session` のキー `broadcasters`: `{ [tabId: number]: { channelId: string, title: string } }`

- [ ] **Step 1: `fetchVideoOwner` 分岐を追加する**

`background.js` の既存 `if (message.type === 'fetchRSS') { ... }` ブロックの直後、同じリスナー関数の中に次を追加する。

```javascript
    if (message.type === 'fetchVideoOwner') {
        const { videoId } = message;

        fetch(`https://www.youtube.com/watch?v=${videoId}`)
            .then(response => response.ok ? response.text() : null)
            .then(text => {
                if (!text) {
                    sendResponse({ success: false });
                    return;
                }

                const idMatch = text.match(/"channelId":"(UC[\w-]{22})"/);
                if (!idMatch) {
                    sendResponse({ success: false });
                    return;
                }

                const nameMatch = text.match(/"author":"((?:[^"\\]|\\.)*)"/);
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
```

`"author":"..."` は JSON 文字列としてエスケープされているため、`JSON.parse` で復元する。復元に失敗しても `channelId` さえ取れれば成功として返す。

- [ ] **Step 2: `broadcasterDetected` 分岐を追加する**

Step 1 で追加したブロックの直後、同じリスナー関数の中に次を追加する。

```javascript
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
```

`sendResponse` を呼ばず `true` も返さないため、送信側は応答を待たない。

- [ ] **Step 3: タブ削除時の掃除を追加する**

`background.js` の末尾（`chrome.runtime.onMessage.addListener(...)` の閉じ括弧の外）に追加する。

```javascript
// Drop broadcaster info when its tab goes away
chrome.tabs.onRemoved.addListener(async (tabId) => {
    const result = await chrome.storage.session.get(['broadcasters']);
    const broadcasters = result.broadcasters || {};
    if (broadcasters[tabId] === undefined) return;

    delete broadcasters[tabId];
    await chrome.storage.session.set({ broadcasters });
});
```

- [ ] **Step 4: service worker が構文エラーなく起動することを確認する**

1. `chrome://extensions` を開き、この拡張機能のカードで「更新」（リロードアイコン）を押す
2. カード内の「Service Worker」リンクをクリックして DevTools を開く
3. Console にエラーが出ていないことを確認する

期待結果: Console は空、または既存の無関係なログのみ。赤いエラーが無い。

- [ ] **Step 5: `fetchVideoOwner` が実際に配信者を返すことを確認する**

Service Worker の DevTools の Console で、現在配信中またはアーカイブされたライブ動画の動画ID（例として YouTube で適当なライブ配信を開き URL の `v=` の値）を使って次を実行する。

```javascript
chrome.runtime.sendMessage({ type: 'fetchVideoOwner', videoId: '<動画ID>' }, console.log)
```

期待結果: `{ success: true, channelId: "UC...", title: "<チャンネル名>" }` が出力される。`channelId` が `UC` で始まる 24 文字であること、`title` がその配信のチャンネル名と一致することを確認する。

- [ ] **Step 6: コミットする**

```bash
git add background.js
git commit -m "feat: add broadcaster resolution and per-tab broadcaster tracking to background"
```

---

### Task 2: content.js にフィルタ設定の読み出しと配信者解決の中継を追加する

**Files:**
- Modify: `content.js`（`chrome.runtime.onMessage` リスナーと `window` の `message` リスナーの両方に分岐を追加）

**Interfaces:**
- Consumes: Task 1 の `{ type: 'fetchVideoOwner', videoId }` と `{ type: 'broadcasterDetected', channelId, title }`
- Produces（すべて `window.postMessage` によるページ内スクリプトとのやり取り）:
  - 受信 `{ type: 'getFilterSettings' }` → 送信 `{ type: 'filterSettingsLoaded', filterMode, allowList, blockList }`
  - 受信 `{ type: 'resolveVideoOwner', videoId, messageId }` → 送信 `{ type: 'videoOwnerResolved', messageId, success, channelId?, title? }`
  - 受信 `{ type: 'broadcasterDetected', channelId, title }` → background へ中継（応答なし）
  - 拡張からの `{ type: 'filterSettingsChanged' }` → 送信 `{ type: 'filterSettingsChanged' }`

- [ ] **Step 1: 拡張からの `filterSettingsChanged` を中継する**

`content.js` の `chrome.runtime.onMessage.addListener` の中、既存の `nicknameUpdated` 分岐の直後に追加する。

```javascript
    if (message.type === 'filterSettingsChanged') {
        window.postMessage({ type: 'filterSettingsChanged' }, '*');
    }
```

- [ ] **Step 2: フィルタ設定の読み出しを追加する**

`content.js` の `window.addEventListener('message', async (event) => { ... })` の中、既存の `loadNicknames` 分岐の直後に追加する。

```javascript
    if (event.data.type === 'getFilterSettings') {
        try {
            const result = await chrome.storage.local.get({
                filterMode: 'all',
                allowList: {},
                blockList: {}
            });
            window.postMessage({
                type: 'filterSettingsLoaded',
                filterMode: result.filterMode,
                allowList: result.allowList,
                blockList: result.blockList
            }, '*');
        } catch (error) {
            console.error('[Content Script] Error loading filter settings:', error);
        }
    }
```

- [ ] **Step 3: 動画IDからの配信者解決を追加する**

Step 2 で追加したブロックの直後に追加する。

```javascript
    if (event.data.type === 'resolveVideoOwner') {
        try {
            const { videoId, messageId } = event.data;
            const OWNER_CACHE_DURATION = 7 * 24 * 60 * 60 * 1000;

            const stored = await chrome.storage.local.get(['videoOwnerCache']);
            const cache = stored.videoOwnerCache || {};
            const entry = cache[videoId];

            if (entry && (Date.now() - entry.timestamp) < OWNER_CACHE_DURATION) {
                window.postMessage({
                    type: 'videoOwnerResolved',
                    messageId: messageId,
                    success: true,
                    channelId: entry.channelId,
                    title: entry.title
                }, '*');
                return;
            }

            chrome.runtime.sendMessage({
                type: 'fetchVideoOwner',
                videoId: videoId
            }, async (response) => {
                if (chrome.runtime.lastError || !response || !response.success) {
                    window.postMessage({
                        type: 'videoOwnerResolved',
                        messageId: messageId,
                        success: false
                    }, '*');
                    return;
                }

                cache[videoId] = {
                    channelId: response.channelId,
                    title: response.title,
                    timestamp: Date.now()
                };
                await chrome.storage.local.set({ videoOwnerCache: cache });

                window.postMessage({
                    type: 'videoOwnerResolved',
                    messageId: messageId,
                    success: true,
                    channelId: response.channelId,
                    title: response.title
                }, '*');
            });
        } catch (error) {
            console.error('[Content Script] Error resolving video owner:', error);
        }
    }
```

取得に失敗した場合はキャッシュに残さないため、次回の読み込みで再試行される。

- [ ] **Step 4: 配信者情報の background への中継を追加する**

Step 3 で追加したブロックの直後に追加する。

```javascript
    if (event.data.type === 'broadcasterDetected') {
        try {
            chrome.runtime.sendMessage({
                type: 'broadcasterDetected',
                channelId: event.data.channelId,
                title: event.data.title
            }).catch(() => {});
        } catch (error) {
            console.error('[Content Script] Error reporting broadcaster:', error);
        }
    }
```

- [ ] **Step 5: 中継が動くことを確認する**

1. `chrome://extensions` で拡張機能を「更新」する
2. YouTube のライブ配信ページを開き、DevTools の Console を開く
3. Console 上部のフレーム選択（コンテキストセレクタ）が `top` になっていることを確認したうえで、次を実行する

```javascript
window.postMessage({ type: 'getFilterSettings' }, '*');
window.addEventListener('message', (e) => { if (e.data.type === 'filterSettingsLoaded') console.log('OK', e.data); });
```

期待結果: `OK { type: 'filterSettingsLoaded', filterMode: 'all', allowList: {}, blockList: {} }` が出力される。

4. 続けて、同じ Console で動画IDを指定して次を実行する

```javascript
window.addEventListener('message', (e) => { if (e.data.type === 'videoOwnerResolved') console.log('OWNER', e.data); });
window.postMessage({ type: 'resolveVideoOwner', videoId: '<動画ID>', messageId: 'test1' }, '*');
```

期待結果: `OWNER { type:'videoOwnerResolved', messageId:'test1', success:true, channelId:'UC...', title:'...' }` が出力される。

5. `chrome://extensions` の Service Worker DevTools の Console で次を実行し、キャッシュされたことを確認する

```javascript
chrome.storage.local.get(['videoOwnerCache'], console.log)
```

期待結果: `videoOwnerCache` に該当の動画IDのエントリが入っている。

- [ ] **Step 6: コミットする**

```bash
git add content.js
git commit -m "feat: relay filter settings and broadcaster resolution in content script"
```

---

### Task 3: inject.js に配信者判定と条件付き監視開始を実装する

これが軽量化の本体。変換対象外の配信では `MutationObserver` を起動せず、視聴者チャンネルの RSS 取得も発生させない。

**Files:**
- Modify: `inject.js`（セレクタ配列の共通化、状態変数の追加、`restoreAllMessages()` の新設、起動シーケンスの差し替え）

**Interfaces:**
- Consumes: Task 2 の `getFilterSettings` / `resolveVideoOwner` / `broadcasterDetected` / `filterSettingsChanged`
- Produces: なし（このファイルが最終消費者）

- [ ] **Step 1: メッセージセレクタ配列を共通の定数にまとめる**

`inject.js` には次の 4 要素の配列が `updateAllMessages()`、`processMessageNode()` 内、`observer` のコールバック、`findChatAndStart()` の 4 箇所に重複している。

```javascript
'yt-live-chat-text-message-renderer'
'yt-live-chat-paid-message-renderer'
'yt-live-chat-membership-item-renderer'
'yt-live-chat-paid-sticker-renderer'
```

ファイル冒頭の `const CACHE_DURATION = ...` の行の直後に定数を追加する。

```javascript
    const MESSAGE_SELECTORS = [
        'yt-live-chat-text-message-renderer',
        'yt-live-chat-paid-message-renderer',
        'yt-live-chat-membership-item-renderer',
        'yt-live-chat-paid-sticker-renderer'
    ];
```

そのうえで、4 箇所のローカル配列宣言（`const messageSelectors = [...]` と `processMessageNode()` 内の `const selectors = [...]`）を削除し、参照箇所を `MESSAGE_SELECTORS` に置き換える。`processMessageNode()` 冒頭の `node.matches('yt-live-chat-...')` を並べた 4 つの真偽値判定と、それを使ったログ出力の三項演算子はそのまま残す。

- [ ] **Step 2: フィルタ用の状態変数を追加する**

Step 1 で追加した `MESSAGE_SELECTORS` の直後に追加する。

```javascript
    let filterMode = 'all';
    let allowList = {};
    let blockList = {};
    let broadcasterId = null;
    let conversionEnabled = false;
    let observing = false;
    let resourcesLoaded = false;
```

- [ ] **Step 3: フィルタ設定の取得関数を追加する**

`loadCache` の定義の直後に追加する。既存の `loadCache` と同じ「postMessage して応答を待ち、1 秒でタイムアウト」の形に揃える。

```javascript
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
```

- [ ] **Step 4: 配信者IDの解決関数を追加する**

Step 3 の直後に追加する。

```javascript
    const getVideoId = () => {
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
        // Same-origin parent frame holds the player data on a normal watch page
        try {
            const host = window.parent !== window ? window.parent : window;
            const details = host.ytInitialPlayerResponse?.videoDetails;
            if (details?.channelId) {
                return { channelId: details.channelId, title: details.author || '' };
            }
        } catch {
            // Cross-origin or not available; fall through
        }

        const videoId = getVideoId();
        if (!videoId) return null;

        return new Promise((resolve) => {
            const messageId = `owner_${videoId}_${Date.now()}`;
            const handler = (event) => {
                if (event.source !== window) return;
                if (event.data.type === 'videoOwnerResolved' && event.data.messageId === messageId) {
                    window.removeEventListener('message', handler);
                    resolve(event.data.success
                        ? { channelId: event.data.channelId, title: event.data.title || '' }
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
```

- [ ] **Step 5: 表示を元に戻す関数を追加する**

`updateAllMessages` の定義の直後に追加する。

```javascript
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
```

`dataset.handleModified` を消すのは、再度有効化されたときに `processMessageNode()` の「処理済みならスキップ」判定に引っかからないようにするため。`dataset.originalName` は残すので、再有効化時に `updateAllMessages()` でも復元できる。

- [ ] **Step 6: 起動シーケンスを判定付きに差し替える**

`inject.js` の末尾にある次の 3 行のブロックを削除する。

```javascript
    // Initial check, in case the chat is already there
    if (!findChatAndStart()) {
        if (DEBUG) console.log('[YT Handle Enhancer] Waiting for chat app...');
        // If not, wait for it to be added to the DOM
        bodyObserver.observe(document.body, { childList: true, subtree: true });
    }
```

同じ位置に次を書く。

```javascript
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
                title: broadcaster.title
            }, '*');
            if (DEBUG) console.log(`[YT Handle Enhancer] Broadcaster: ${broadcaster.title} (${broadcaster.channelId})`);
        } else if (DEBUG) {
            console.log('[YT Handle Enhancer] Broadcaster could not be resolved');
        }

        await applyFilter();
    };

    init();
```

- [ ] **Step 7: 起動時の無条件な読み込みを削除する**

Step 6 の `applyFilter()` が変換有効時にだけ読み込むようになったため、ファイル前半の次の 3 箇所を削除する。

```javascript
    // Load initial display mode from storage
    window.postMessage({ type: 'getDisplayMode' }, '*');

    // Load nicknames from storage
    window.postMessage({ type: 'loadNicknames' }, '*');
```

および `saveCacheEntry` の定義の直後にある

```javascript
    // Initialize cache
    loadCache();
```

これで変換対象外の配信ではストレージ読み出しすら発生しなくなる。

- [ ] **Step 8: 設定変更時の再判定を追加する**

ファイル冒頭の `window.addEventListener('message', (event) => { ... })` の中、`nicknamesLoaded` 分岐の直後に追加する。

```javascript
        if (event.data.type === 'filterSettingsChanged') {
            requestFilterSettings().then(applyFilter);
        }
```

`applyFilter` と `requestFilterSettings` は `const` で後方に定義されているが、このコールバックが実行されるのは初期化完了後のため参照できる。

- [ ] **Step 9: 既定モードで従来どおり動くことを確認する**

1. `chrome://extensions` で拡張機能を「更新」する
2. `chrome://extensions` の Service Worker DevTools の Console で `chrome.storage.local.get(console.log)` を実行し、`filterMode` が未設定（＝既定の `all`）であることを確認する
3. YouTube のライブ配信ページを開く

期待結果: チャットの表示名が従来どおり変換される（`両方表示` なら `チャンネル名 (ユーザー名)` 形式）。

- [ ] **Step 10: 許可リストモードで変換が止まることを確認する**

1. Service Worker DevTools の Console で次を実行する

```javascript
chrome.storage.local.set({ filterMode: 'allow', allowList: {} })
```

2. ライブ配信ページを開き直し、DevTools の Network タブを開いて `videos.xml` でフィルタする

期待結果: チャットの表示名が変換されない（元のユーザー名のまま）。Network に `videos.xml` へのリクエストが 1 件も出ない。

- [ ] **Step 11: 許可リストに入れると即座に変換が始まることを確認する**

1. 手順は Step 10 の状態から続ける。ライブ配信ページは開いたままにする
2. Service Worker DevTools の Console で、その配信の配信者チャンネルIDを使って次を実行する（配信者IDは配信ページの `ytInitialPlayerResponse.videoDetails.channelId` で確認できる）

```javascript
chrome.storage.local.set({ filterMode: 'allow', allowList: { '<配信者チャンネルID>': 'test' } })
    .then(() => chrome.tabs.query({ url: 'https://www.youtube.com/*' }))
    .then(tabs => tabs.forEach(t => chrome.tabs.sendMessage(t.id, { type: 'filterSettingsChanged' }).catch(() => {})))
```

期待結果: 配信ページをリロードすることなく、その場でチャットの表示名が変換され始める。

- [ ] **Step 12: 許可リストから外すと元の表示に戻ることを確認する**

Step 11 に続けて、Service Worker DevTools の Console で次を実行する。

```javascript
chrome.storage.local.set({ allowList: {} })
    .then(() => chrome.tabs.query({ url: 'https://www.youtube.com/*' }))
    .then(tabs => tabs.forEach(t => chrome.tabs.sendMessage(t.id, { type: 'filterSettingsChanged' }).catch(() => {})))
```

期待結果: すでに変換済みだったチャット行の表示名が、元のユーザー名に戻る。以後の新規メッセージも変換されない。

- [ ] **Step 13: 除外リストモードを確認する**

Service Worker DevTools の Console で次を実行し、配信ページをリロードする。

```javascript
chrome.storage.local.set({ filterMode: 'block', blockList: { '<配信者チャンネルID>': 'test' } })
```

期待結果: その配信では変換されない。別の配信者のライブ配信を開くと変換される。

- [ ] **Step 14: ポップアウトチャットと Studio で配信者が解決されることを確認する**

1. Service Worker DevTools の Console で `chrome.storage.local.set({ filterMode: 'all' })` を実行して既定に戻す
2. `inject.js` の 4 行目 `const DEBUG = false;` を `true` に変更し、拡張機能を「更新」する
3. ライブ配信のチャット右上のメニューから「チャットを別ウィンドウで表示」（ポップアウト）を選ぶ
4. ポップアウトしたウィンドウの DevTools の Console を確認する

期待結果: `[YT Handle Enhancer] Broadcaster: <チャンネル名> (UC...)` が出力される。

5. 自分のチャンネルでライブ配信中であれば、YouTube Studio のライブ管理画面を開いて同様に Console を確認する（配信していない場合はこの確認は省略してよい）
6. 確認後、`DEBUG` を `false` に戻す

- [ ] **Step 15: コミットする**

```bash
git add inject.js
git commit -m "feat: skip chat observation entirely for non-target broadcasters"
```

---

### Task 4: i18n メッセージを 6 言語に追加する

**Files:**
- Modify: `_locales/ja/messages.json`
- Modify: `_locales/en/messages.json`
- Modify: `_locales/es/messages.json`
- Modify: `_locales/hi/messages.json`
- Modify: `_locales/id/messages.json`
- Modify: `_locales/pt/messages.json`

**Interfaces:**
- Consumes: なし
- Produces: i18n キー `filterSectionTitle` `filterModeAll` `filterModeAllow` `filterModeBlock` `currentBroadcaster` `broadcasterNotDetected` `addToList` `removeFromList` `allowListTitle` `blockListTitle` `listEmpty` `targetChannelsTab`。Task 5 と Task 6 が `chrome.i18n.getMessage()` と `data-i18n` 属性から参照する。

- [ ] **Step 1: `ja` にキーを追加する**

`_locales/ja/messages.json` の最後のエントリ `cacheDescription` の閉じ波括弧の後にカンマを足し、次を追加する。

```json
  "filterSectionTitle": {
    "message": "変換対象",
    "description": "変換対象セクションのタイトル"
  },
  "filterModeAll": {
    "message": "全配信で変換",
    "description": "すべての配信で変換するモード"
  },
  "filterModeAllow": {
    "message": "許可リストの配信のみ",
    "description": "許可リストに登録した配信でのみ変換するモード"
  },
  "filterModeBlock": {
    "message": "除外リスト以外で変換",
    "description": "除外リストに登録した配信以外で変換するモード"
  },
  "currentBroadcaster": {
    "message": "現在の配信者",
    "description": "現在視聴中の配信者のラベル"
  },
  "broadcasterNotDetected": {
    "message": "配信を検出できません",
    "description": "配信者を特定できなかったときのメッセージ"
  },
  "addToList": {
    "message": "このチャンネルを追加",
    "description": "現在の配信者をリストに追加するボタン"
  },
  "removeFromList": {
    "message": "このチャンネルを解除",
    "description": "現在の配信者をリストから削除するボタン"
  },
  "allowListTitle": {
    "message": "許可リスト",
    "description": "許可リスト一覧のタイトル"
  },
  "blockListTitle": {
    "message": "除外リスト",
    "description": "除外リスト一覧のタイトル"
  },
  "listEmpty": {
    "message": "登録されているチャンネルはありません",
    "description": "リストが空のときのメッセージ"
  },
  "targetChannelsTab": {
    "message": "対象配信者",
    "description": "対象配信者タブ"
  }
```

- [ ] **Step 2: `en` にキーを追加する**

`_locales/en/messages.json` の末尾に同じ手順で追加する。`message` の値は次のとおり。`description` は `ja` と同じ英訳でよいが、既存ファイルの `description` の書き方に合わせる。

- `filterSectionTitle`: `Conversion Target`
- `filterModeAll`: `Convert on all streams`
- `filterModeAllow`: `Only streams in the allow list`
- `filterModeBlock`: `All streams except the block list`
- `currentBroadcaster`: `Current broadcaster`
- `broadcasterNotDetected`: `No stream detected`
- `addToList`: `Add this channel`
- `removeFromList`: `Remove this channel`
- `allowListTitle`: `Allow List`
- `blockListTitle`: `Block List`
- `listEmpty`: `No channels registered`
- `targetChannelsTab`: `Target Channels`

- [ ] **Step 3: `es` `hi` `id` `pt` にキーを追加する**

同じ 12 キーを、各言語の既存の文体に合わせて訳して追加する。`_locales/en/messages.json` の値を原文とし、各ファイルの既存エントリの訳語（例えば「キャッシュ」「ニックネーム」に相当する語）と用語を揃える。

すべてのファイルで JSON の構文を壊さないよう、直前のエントリの後にカンマを入れることと、最後のエントリの後にカンマを付けないことを守る。

- [ ] **Step 4: 全ファイルが妥当な JSON であることを確認する**

```bash
for f in _locales/*/messages.json; do node -e "JSON.parse(require('fs').readFileSync('$f','utf8'))" && echo "OK $f"; done
```

期待結果: 6 ファイルすべてに `OK` が出る。エラーが出たファイルを修正する。

- [ ] **Step 5: 全ファイルが同じキー集合を持つことを確認する**

```bash
for f in _locales/*/messages.json; do echo "$f $(node -e "console.log(Object.keys(JSON.parse(require('fs').readFileSync('$f','utf8'))).sort().join(','))" | md5sum | cut -c1-8)"; done
```

期待結果: 6 ファイルすべてで同じハッシュ値が出る。異なるファイルは不足キーまたは余分なキーがあるので修正する。

- [ ] **Step 6: 拡張機能が読み込めることを確認する**

`chrome://extensions` で拡張機能を「更新」する。

期待結果: エラーバッジが出ない。`messages.json` に構文エラーがあると拡張機能の読み込み自体が失敗する。

- [ ] **Step 7: コミットする**

```bash
git add _locales
git commit -m "i18n: add messages for broadcaster filter"
```

---

### Task 5: ポップアップに変換対象セクションを追加する

**Files:**
- Modify: `popup.html`（`.settings` ブロックと `#openSettings` ボタンの間にセクションを挿入）
- Modify: `popup.js`（`openSettings` のハンドラ登録より前に処理を追加）
- Modify: `popup.css`（末尾にスタイルを追加）

**Interfaces:**
- Consumes: Task 1 の `chrome.storage.session` の `broadcasters`、Task 4 の i18n キー、Task 2 の `filterSettingsChanged`
- Produces: `chrome.storage.local` の `filterMode` / `allowList` / `blockList` を書き換え、開いているタブへ `{ type: 'filterSettingsChanged' }` を送る

- [ ] **Step 1: `popup.html` にマークアップを追加する**

`popup.html` の `</div>`（`.settings` の閉じタグ）と `<button id="openSettings" ...>` の間に挿入する。

```html
        <div class="section-divider"></div>
        <h2 class="section-title" data-i18n="filterSectionTitle">Conversion Target</h2>
        <div class="settings">
            <label class="radio-option">
                <input type="radio" name="filterMode" value="all" checked>
                <span data-i18n="filterModeAll">Convert on all streams</span>
            </label>
            <label class="radio-option">
                <input type="radio" name="filterMode" value="allow">
                <span data-i18n="filterModeAllow">Only streams in the allow list</span>
            </label>
            <label class="radio-option">
                <input type="radio" name="filterMode" value="block">
                <span data-i18n="filterModeBlock">All streams except the block list</span>
            </label>
        </div>
        <div class="broadcaster">
            <div class="broadcaster-label" data-i18n="currentBroadcaster">Current broadcaster</div>
            <div class="broadcaster-name" id="broadcasterName"></div>
            <button id="toggleBroadcaster"></button>
        </div>
```

`#broadcasterName` と `#toggleBroadcaster` の中身は `popup.js` が状態に応じて埋めるため、`data-i18n` は付けない。

- [ ] **Step 2: `popup.css` にスタイルを追加する**

`popup.css` の末尾に追加する。

```css
.section-divider {
    border-top: 1px solid #e0e0e0;
    margin: 16px 0;
}

.section-title {
    font-size: 14px;
    font-weight: 600;
    color: #202124;
    text-align: left;
    margin-bottom: 12px;
}

.broadcaster {
    text-align: left;
    margin-bottom: 16px;
}

.broadcaster-label {
    font-size: 12px;
    color: #5f6368;
    margin-bottom: 4px;
}

.broadcaster-name {
    font-size: 14px;
    font-weight: 500;
    color: #202124;
    margin-bottom: 8px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

#toggleBroadcaster {
    width: 100%;
    padding: 10px;
    background-color: #1976d2;
    color: white;
    border: none;
    border-radius: 4px;
    font-size: 13px;
    font-weight: 500;
    cursor: pointer;
    transition: background-color 0.2s;
}

#toggleBroadcaster:hover:not(:disabled) {
    background-color: #1565c0;
}

#toggleBroadcaster:disabled {
    background-color: #dadce0;
    color: #9aa0a6;
    cursor: default;
}
```

- [ ] **Step 3: `popup.js` にフィルタ処理を追加する**

`popup.js` の「Open settings page」のコメントより前、`displayMode` のラジオ処理の後に追加する。

```javascript
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
            toggleBtn.disabled = true;
            return;
        }

        broadcasterName.textContent = broadcaster.title || broadcaster.channelId;

        if (stored.filterMode === 'all') {
            toggleBtn.textContent = chrome.i18n.getMessage('addToList');
            toggleBtn.disabled = true;
            return;
        }

        const list = stored.filterMode === 'allow' ? stored.allowList : stored.blockList;
        const registered = list[broadcaster.channelId] !== undefined;
        toggleBtn.textContent = chrome.i18n.getMessage(registered ? 'removeFromList' : 'addToList');
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

    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (activeTab) {
        const session = await chrome.storage.session.get(['broadcasters']);
        broadcaster = (session.broadcasters || {})[activeTab.id] || null;
    }
    await renderBroadcaster();
```

既存の `displayMode` のラジオは全タブをリロードするが、`filterMode` はリロードせずメッセージで反映する。この違いは意図的なもので、変換の有効・無効はページを読み直さずに切り替わる。

- [ ] **Step 4: 配信ページ以外でのポップアップ表示を確認する**

1. `chrome://extensions` で拡張機能を「更新」する
2. YouTube のトップページを開き、拡張機能アイコンをクリックする

期待結果: 「変換対象」セクションが表示され、モードは「全配信で変換」が選択済み。配信者欄に「配信を検出できません」と出て、ボタンがグレーアウトして押せない。

- [ ] **Step 5: 配信ページでの配信者表示を確認する**

1. YouTube のライブ配信ページを開く
2. チャットが読み込まれてから拡張機能アイコンをクリックする

期待結果: 配信者欄にその配信のチャンネル名が表示される。モードが「全配信で変換」のままなのでボタンはまだグレーアウトしている。

- [ ] **Step 6: ワンクリック登録が動くことを確認する**

1. Step 5 の状態でポップアップの「許可リストの配信のみ」を選ぶ

期待結果: チャットの変換がその場で止まり、すでに変換済みだった行が元のユーザー名に戻る。ポップアップのボタンが有効になり「このチャンネルを追加」と表示される。

2. 「このチャンネルを追加」を押す

期待結果: チャットの変換がその場で再開する。ボタンの表示が「このチャンネルを解除」に変わる。

3. 「このチャンネルを解除」を押す

期待結果: 変換が止まり、表示が元に戻る。ボタンが「このチャンネルを追加」に戻る。

4. ポップアップを閉じて開き直す

期待結果: 選択したモードとボタンの状態が保持されている。

- [ ] **Step 7: コミットする**

```bash
git add popup.html popup.js popup.css
git commit -m "feat: add conversion target section to popup"
```

---

### Task 6: 設定ページに対象配信者タブを追加する

**Files:**
- Modify: `settings.html`（タブボタンを 1 つとタブコンテンツを 1 つ追加）
- Modify: `settings.js`（末尾のキャッシュ処理の前に対象配信者タブの処理を追加）
- Modify: `settings.css`（末尾にスタイルを追加）

**Interfaces:**
- Consumes: Task 4 の i18n キー、Task 5 と共有する `chrome.storage.local` の `filterMode` / `allowList` / `blockList`
- Produces: なし

- [ ] **Step 1: `settings.html` にタブボタンを追加する**

`settings.html` の `.tabs` ブロック内、`nickname` のボタンと `cache` のボタンの間に追加する。

```html
            <button class="tab-button" data-tab="target" data-i18n="targetChannelsTab">Target Channels</button>
```

- [ ] **Step 2: `settings.html` にタブコンテンツを追加する**

`#nickname-tab` の `</div>` と `#cache-tab` の `<div ...>` の間に追加する。

```html
        <div class="tab-content" id="target-tab">
            <h2 data-i18n="filterSectionTitle">Conversion Target</h2>
            <div class="settings">
                <label class="radio-option">
                    <input type="radio" name="filterMode" value="all" checked>
                    <span data-i18n="filterModeAll">Convert on all streams</span>
                </label>
                <label class="radio-option">
                    <input type="radio" name="filterMode" value="allow">
                    <span data-i18n="filterModeAllow">Only streams in the allow list</span>
                </label>
                <label class="radio-option">
                    <input type="radio" name="filterMode" value="block">
                    <span data-i18n="filterModeBlock">All streams except the block list</span>
                </label>
            </div>
            <h2 data-i18n="allowListTitle">Allow List</h2>
            <div class="channel-list" id="allowListView"></div>
            <h2 class="list-heading" data-i18n="blockListTitle">Block List</h2>
            <div class="channel-list" id="blockListView"></div>
        </div>
```

タブ切り替えは既存の `settings.js` のロジックが `data-tab` の値から `${tabName}-tab` を引くため、追加の配線は要らない。

- [ ] **Step 3: `settings.css` にスタイルを追加する**

`settings.css` の末尾に追加する。既存の `.nickname-item` のスタイルを流用せず、専用のクラスを持たせる。

```css
.channel-list {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(400px, 1fr));
    gap: 16px;
    margin-bottom: 24px;
}

.channel-item {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 16px;
    background: #f8f9fa;
    border-radius: 4px;
    border: 1px solid #e0e0e0;
}

.channel-item .channel-info {
    flex: 1;
    min-width: 0;
}

.channel-item .channel-name {
    font-size: 14px;
    font-weight: 500;
    color: #202124;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.channel-item button {
    padding: 8px 16px;
    background-color: #f44336;
    color: white;
    border: none;
    border-radius: 4px;
    font-size: 13px;
    cursor: pointer;
    transition: background-color 0.2s;
    white-space: nowrap;
}

.channel-item button:hover {
    background-color: #d32f2f;
}

.list-heading {
    margin-top: 8px;
}
```

- [ ] **Step 4: `settings.js` に対象配信者タブの処理を追加する**

`settings.js` の「Cache management」のコメントより前に追加する。

```javascript
    // Conversion target management
    const FILTER_DEFAULTS = { filterMode: 'all', allowList: {}, blockList: {} };
    const filterRadios = document.querySelectorAll('input[name="filterMode"]');
    const allowListView = document.getElementById('allowListView');
    const blockListView = document.getElementById('blockListView');

    const notifyFilterChanged = async () => {
        const youtubeTabs = await chrome.tabs.query({ url: 'https://www.youtube.com/*' });
        const studioTabs = await chrome.tabs.query({ url: 'https://studio.youtube.com/*' });
        [...youtubeTabs, ...studioTabs].forEach(tab => {
            chrome.tabs.sendMessage(tab.id, { type: 'filterSettingsChanged' }).catch(() => {});
        });
    };

    const renderChannelList = (container, list, storageKey) => {
        container.textContent = '';

        const entries = Object.entries(list);
        if (entries.length === 0) {
            const empty = document.createElement('p');
            empty.textContent = chrome.i18n.getMessage('listEmpty');
            container.appendChild(empty);
            return;
        }

        entries.sort((a, b) => a[1].localeCompare(b[1]));

        entries.forEach(([channelId, name]) => {
            const item = document.createElement('div');
            item.className = 'channel-item';

            const info = document.createElement('div');
            info.className = 'channel-info';

            const nameElement = document.createElement('div');
            nameElement.className = 'channel-name';
            nameElement.textContent = name;
            info.appendChild(nameElement);

            const removeButton = document.createElement('button');
            removeButton.textContent = chrome.i18n.getMessage('removeNickname');
            removeButton.addEventListener('click', async () => {
                const stored = await chrome.storage.local.get({ [storageKey]: {} });
                const target = stored[storageKey];
                delete target[channelId];
                await chrome.storage.local.set({ [storageKey]: target });
                await notifyFilterChanged();
                await renderTargetTab();
            });

            item.appendChild(info);
            item.appendChild(removeButton);
            container.appendChild(item);
        });
    };

    const renderTargetTab = async () => {
        const stored = await chrome.storage.local.get(FILTER_DEFAULTS);
        filterRadios.forEach(radio => {
            radio.checked = radio.value === stored.filterMode;
        });
        renderChannelList(allowListView, stored.allowList, 'allowList');
        renderChannelList(blockListView, stored.blockList, 'blockList');
    };

    filterRadios.forEach(radio => {
        radio.addEventListener('change', async (e) => {
            await chrome.storage.local.set({ filterMode: e.target.value });
            await notifyFilterChanged();
        });
    });

    renderTargetTab();
```

削除ボタンのラベルには既存の `removeNickname`（「削除」）を再利用する。

- [ ] **Step 5: タブが表示され一覧が出ることを確認する**

1. `chrome://extensions` で拡張機能を「更新」する
2. ポップアップから「設定を開く」を押す
3. 「対象配信者」タブをクリックする

期待結果: モード選択のラジオが表示され、現在のモードが選択されている。許可リストと除外リストの見出しが出て、空なら「登録されているチャンネルはありません」と表示される。

4. Task 5 の Step 6 の手順でライブ配信を許可リストに追加してから、設定ページをリロードして「対象配信者」タブを開く

期待結果: 許可リストにそのチャンネル名が表示される。

- [ ] **Step 6: 削除とモード切替が反映されることを確認する**

1. ライブ配信ページを開いたまま、設定ページの許可リストで「削除」を押す

期待結果: 一覧からその行が消える。ライブ配信ページのチャットの変換がその場で止まり、表示が元に戻る。

2. 設定ページでモードを「全配信で変換」に切り替える

期待結果: ライブ配信ページのチャットの変換がその場で再開する。

3. ポップアップを開く

期待結果: ポップアップのモード選択も「全配信で変換」になっている（同じストレージを共有しているため）。

- [ ] **Step 7: コミットする**

```bash
git add settings.html settings.js settings.css
git commit -m "feat: add target channels tab to settings page"
```

---

### Task 7: バージョンを上げて全体を通しで確認する

**Files:**
- Modify: `manifest.json:4`（`"version": "1.0.4"` を `"version": "1.0.5"` に）

**Interfaces:**
- Consumes: Task 1 から Task 6 のすべて
- Produces: なし

- [ ] **Step 1: バージョンを更新する**

`manifest.json` の `"version": "1.0.4"` を `"version": "1.0.5"` にする。

- [ ] **Step 2: 拡張機能を新規インストール状態から確認する**

1. `chrome://extensions` でこの拡張機能を「削除」する
2. 「パッケージ化されていない拡張機能を読み込む」でプロジェクトのフォルダを読み込む
3. YouTube のライブ配信ページを開く

期待結果: ストレージが空の初期状態で、従来どおり全配信で変換される（`filterMode` の既定が `all` のため既存ユーザーの挙動が変わらないことの確認）。

- [ ] **Step 3: 設計書のテスト項目を順に確認する**

`docs/superpowers/specs/2026-08-06-broadcaster-filter-design.md` の「テスト」節にある 10 項目を上から順に実行する。

1. `filterMode = 'all'`（初期状態）で、従来どおり全配信で変換される
2. `filterMode = 'allow'` かつ許可リストが空のとき、どの配信でも変換されず、DevTools の Network に `videos.xml` の取得が出ない
3. 視聴中の配信をポップアップから許可リストに追加すると、リロードなしでその場で変換が始まる
4. 許可リストから解除すると、その場で元の表示名に戻る
5. `filterMode = 'block'` で除外リストに入れた配信のみ変換されない
6. ポップアップで配信者名が正しく表示される（通常の視聴ページ）
7. ポップアウトしたチャット単独タブでも配信者が検出される
8. YouTube Studio のライブ配信チャットでも配信者が検出される（配信中でなければ省略可）
9. 配信ページ以外（YouTube トップなど）でポップアップを開くと「配信を検出できません」と表示され、トグルが無効になる
10. 設定ページの「対象配信者」タブでリストの表示と削除ができる

期待結果: 10 項目すべてが期待どおりに動く。失敗した項目は該当タスクに戻って修正する。

- [ ] **Step 4: 既存機能が壊れていないことを確認する**

1. ポップアップで表示モードを「ユーザー名のみ」「ハンドルのみ」「両方表示」に切り替え、それぞれチャットの表示が変わることを確認する
2. 設定ページの「ニックネーム」タブでニックネームを設定し、チャットに反映されることを確認する
3. 設定ページの「キャッシュ」タブでキャッシュをクリアできることを確認する

期待結果: 3 つとも従来どおり動く。

- [ ] **Step 5: 言語切替で文言が出ることを確認する**

Chrome の表示言語を英語に変更して Chrome を再起動し、ポップアップと設定ページを開く。

期待結果: 「変換対象」セクションと「対象配信者」タブの文言が英語で表示され、キー名がそのまま出ている箇所や空欄が無い。確認後、言語を元に戻す。

- [ ] **Step 6: コミットする**

```bash
git add manifest.json
git commit -m "chore: bump version to 1.0.5"
```

---

## Self-Review

**1. Spec coverage**

| 設計書の項目 | 実装タスク |
| --- | --- |
| データモデル（`filterMode` / `allowList` / `blockList`） | Task 5・Task 6 で書き込み、Task 2・Task 3 で読み出し |
| `videoOwnerCache` と 1 週間の有効期限 | Task 2 Step 3 |
| モードごとの判定と解決失敗時の安全側の扱い | Task 3 Step 6 の `shouldConvert()` |
| 経路1（親フレームのプレイヤーデータ） | Task 3 Step 4 の `resolveBroadcaster()` 前半 |
| 経路2（動画IDから background 経由） | Task 3 Step 4 後半、Task 2 Step 3、Task 1 Step 1 |
| 変換無効時に observer を起動しない | Task 3 Step 6・Step 7 |
| 設定変更時の切り替えと `restoreAllMessages()` | Task 3 Step 5・Step 6・Step 8 |
| 配信切り替えの検知（iframe 再読み込みに委ねる） | 追加実装なし。設計どおり |
| `chrome.storage.session` によるポップアップへの受け渡し | Task 1 Step 2・Step 3、Task 5 Step 3 |
| ポップアップ UI | Task 5 |
| 設定ページ UI | Task 6 |
| チャンネル名を `textContent` で描画 | Task 6 Step 4 の `renderChannelList()` |
| i18n 6 言語 | Task 4 |
| バージョン 1.0.5 | Task 7 Step 1 |
| 新しいパーミッション不要 | Global Constraints に明記。`manifest.json` の `permissions` は変更しない |

未カバーの項目なし。

**2. Placeholder scan**

「適切にエラー処理する」「同様に」といった曖昧な指示は使っていない。Task 4 Step 3 の 4 言語分の訳語だけは実際の文字列を列挙していないが、これは翻訳という性質上、原文（Step 2 の英語）と各ファイルの既存用語に揃えるという判断基準を示すのが適切なため、意図的にそうしている。

**3. Type consistency**

- メッセージ種別: `fetchVideoOwner` / `broadcasterDetected` / `getFilterSettings` / `filterSettingsLoaded` / `resolveVideoOwner` / `videoOwnerResolved` / `filterSettingsChanged` — Task 1・2・3・5・6 を通じて綴りが一致していることを確認済み。
- ストレージキー: `filterMode` / `allowList` / `blockList` / `videoOwnerCache` / `broadcasters` — 全タスクで一致。
- 関数名: `requestFilterSettings` / `resolveBroadcaster` / `getVideoId` / `shouldConvert` / `startWatching` / `stopWatching` / `applyFilter` / `restoreAllMessages` / `renderBroadcaster` / `notifyFilterChanged` / `renderChannelList` / `renderTargetTab` — 定義と呼び出しが一致。
- `notifyFilterChanged` は `popup.js`（Task 5）と `settings.js`（Task 6）に同名で別々に定義される。両ファイルはスコープが独立しているため衝突しない。既存コードもタブ通知処理を各ファイルで重複させているため、この書き方を踏襲する。
- `FILTER_DEFAULTS` も同様に `popup.js` と `settings.js` に別々に定義される。
- `filterRadios` は `popup.js` と `settings.js` で同名だが、それぞれ自分の HTML の要素を引くため問題ない。
