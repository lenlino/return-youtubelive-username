# 変換対象配信者フィルタ 設計書

作成日: 2026-08-06

## 背景と目的

現状、この拡張機能は YouTube のライブチャットが存在するすべてのページで動作し、
チャットに現れた全視聴者のチャンネルIDに対して RSS フィードを取得している。
そのため、視聴する配信すべてで DOM 監視とネットワーク取得が走り、動作が重くなる。

視聴者が「この配信者のチャットでだけ変換したい」と指定できるようにし、
対象外の配信では処理を一切走らせないことで負荷を下げる。

## 用語

- **配信者** — その配信（動画）を所有するチャンネル。チャットの発言者ではない。
- **配信者ID** — 配信者チャンネルの `UC` から始まるチャンネルID。
- **変換** — チャット発言者の表示名をチャンネル名・ハンドル・ニックネームに置き換える既存機能。

## データモデル

保存先は `chrome.storage.local`（既存の `nicknames` / `channelCache` と同じ）。

| キー | 型 | 既定値 | 説明 |
| --- | --- | --- | --- |
| `filterMode` | `'all' \| 'allow' \| 'block'` | `'all'` | 変換対象の決定方式 |
| `allowList` | `{ [channelId: string]: string }` | `{}` | 許可リスト。値は表示用のチャンネル名 |
| `blockList` | `{ [channelId: string]: string }` | `{}` | 除外リスト。値は表示用のチャンネル名 |
| `videoOwnerCache` | `{ [videoId: string]: { channelId, title, timestamp } }` | `{}` | 動画ID → 配信者の解決結果キャッシュ |

`filterMode` の既定値を `'all'` とすることで、既存ユーザーの挙動は変わらない。

### モードごとの判定

配信者IDを `B` とする。

| `filterMode` | 変換する条件 |
| --- | --- |
| `all` | 常に変換する（`B` が不明でも変換する） |
| `allow` | `B` が判明し、かつ `allowList` に存在する |
| `block` | `B` が不明、または `blockList` に存在しない |

`allow` モードで配信者IDが解決できなかった場合は変換しない。
`block` モードで解決できなかった場合は変換する。
どちらも「そのモードを選んだユーザーの意図から見て安全側」に倒す。

`videoOwnerCache` の有効期限は既存の `channelCache` と同じ 1 週間とする。

## 配信者IDの検出

`inject.js` はチャットの iframe 内（またはポップアウトチャットのトップレベル）で動く。
以下の順で解決を試み、最初に成功したものを採用する。

### 経路1: 親フレームのプレイヤーデータ（ネットワーク不要）

通常の視聴ページ（`https://www.youtube.com/watch?v=...`）では、チャットの iframe と
親フレームは同一オリジンのため、親のグローバル変数を直接参照できる。

```
window.parent.ytInitialPlayerResponse?.videoDetails?.channelId
window.parent.ytInitialPlayerResponse?.videoDetails?.author
```

自身がトップレベルの場合（`window.parent === window`）は自フレームの同変数を見る。
クロスオリジン例外に備えて `try/catch` で囲み、失敗したら経路2へ落とす。

YouTube は SPA 遷移で動画を切り替えるため、この値は配信切り替え時に更新される。
再判定のタイミングは「配信切り替えの検知」節を参照。

### 経路2: 動画IDから解決（フォールバック）

ポップアウトチャット（`https://www.youtube.com/live_chat?is_popout=1&v=...`）や
YouTube Studio では経路1が使えない。動画IDを次の順で取得する。

1. 自フレームの URL のクエリパラメータ `v`
2. `document.referrer` の URL のクエリパラメータ `v`
3. `document.referrer` が Studio 形式（`/video/<videoId>/livestreaming` 等）ならそのパス部分

動画IDが得られたら `videoOwnerCache` を確認し、なければ content script 経由で
background service worker に解決を依頼する。

background 側は `https://www.youtube.com/watch?v=<videoId>` を取得し、
HTML から `"channelId":"UC..."` と `"author":"..."` を正規表現で抽出して返す。
既存の `fetchRSS` ハンドラと同じ形の `chrome.runtime.onMessage` ハンドラとして追加する。

解決結果は `videoOwnerCache` に保存するため、1つの配信につき最大1回しか取得しない。
取得失敗時は「配信者ID不明」として扱う（キャッシュには残さず、次回再試行する）。

## フィルタの適用

### 変換無効時の振る舞い

これが軽量化の本体である。変換が無効と判定された場合、
`MutationObserver` を **起動しない**。既存メッセージの走査も行わない。
結果として、DOM 走査も視聴者チャンネルの RSS 取得も一切発生せず、
対象外の配信では拡張機能が存在しないのとほぼ同じ負荷になる。

`inject.js` の起動シーケンスを次のように変更する。

1. 設定（`filterMode` / `allowList` / `blockList`）を読み込む
2. 配信者IDを解決する
3. 判定して `conversionEnabled` を決める
4. `conversionEnabled` が真のときだけ `findChatAndStart()` を呼ぶ

現状は起動直後に無条件で `findChatAndStart()` を呼んでいる箇所を、この判定の後ろに移す。

### 設定変更時の切り替え

ポップアップや設定ページでモードやリストを変更したときは、既存の
`clearCache` / `nicknameUpdated` と同じ経路（`chrome.tabs.sendMessage` →
content script → `window.postMessage`）で `filterSettingsChanged` を通知する。

`inject.js` は通知を受けて再判定し、

- 無効 → 有効: `findChatAndStart()` を呼ぶ（既存メッセージの処理 + observer 開始）
- 有効 → 無効: `observer.disconnect()` し、`restoreAllMessages()` で表示を元に戻す
- 変化なし: 何もしない

`restoreAllMessages()` は新設する。既存の `updateAllMessages()` と同じセレクタ群を走査し、
`authorChip.dataset.originalName` が残っているものについて
`#author-name` の `textContent` をその値に戻し、`dataset.handleModified` を削除する。
`dataset.handleModified` を消すのは、再度有効化されたときに
`processMessageNode()` の「処理済みなのでスキップ」判定に引っかからないようにするため。

### 配信切り替えの検知

YouTube の SPA 遷移で別の配信に移ると配信者が変わる。
チャットの iframe は配信切り替え時に再読み込みされるため、
`inject.js` 自体が再実行される。したがって追加の遷移検知は行わない。

## 配信者情報のポップアップへの受け渡し

ポップアップは「今どの配信を見ているか」を知る必要があるが、
content script は複数フレームで動くため、ポップアップから直接問い合わせると
どのフレームが答えるか一意に定まらない。

そこで、配信者IDを解決した `inject.js` が content script 経由で
`chrome.runtime.sendMessage({ type: 'broadcasterDetected', channelId, title })` を送り、
background service worker が送信元のタブIDをキーに
`chrome.storage.session` へ保存する構成にする。

```
chrome.storage.session:
  broadcasters: { [tabId: number]: { channelId, title } }
```

ポップアップは `chrome.tabs.query({ active: true, currentWindow: true })` で
現在のタブIDを得て、`broadcasters[tabId]` を読む。
エントリがなければ「配信を検出できません」と表示する。

`chrome.storage.session` は既存の `storage` パーミッションで利用でき、
ブラウザ終了時に自動で破棄されるため後始末が要らない。
タブを閉じたときのエントリ削除は `chrome.tabs.onRemoved` で行う。

`inject.js` は配信者IDの解決に失敗した場合もこのメッセージを送らないため、
ポップアップ側は「未検出」として扱う。

## UI

### ポップアップ（`popup.html` / `popup.js` / `popup.css`）

既存の表示モード設定の下に「変換対象」セクションを追加する。

- **モード選択** — ラジオボタン3つ
  - 全配信で変換
  - 許可リストの配信のみ
  - 除外リスト以外で変換
- **現在の配信者** — 検出したチャンネル名を表示。未検出なら「配信を検出できません」
- **トグルボタン** — 現在の配信者を、選択中のモードに対応するリストへ追加／削除する
  - `filterMode` が `allow` → 許可リストへの追加／削除
  - `filterMode` が `block` → 除外リストへの追加／削除
  - `filterMode` が `all` → ボタンは無効化（対象リストがないため）
  - 配信者が未検出のときも無効化

ボタンのラベルは現在の登録状態に応じて「このチャンネルを追加」／「このチャンネルを解除」を出し分ける。

保存後は既存の表示モード変更と同じ方式で、YouTube と Studio の全タブへ
`filterSettingsChanged` を送信する。

### 設定ページ（`settings.html` / `settings.js` / `settings.css`）

既存のタブ UI に「対象配信者」タブを追加する。内容は、

- モード選択ラジオ（ポップアップと同じ3択・同じストレージを共有）
- 許可リストの一覧（チャンネル名 + 削除ボタン）
- 除外リストの一覧（チャンネル名 + 削除ボタン）

リストが空のときは説明文を表示する。
既存のニックネーム一覧の描画・保存処理と同じ書き方に揃える。

チャンネル名の描画は既存のニックネーム一覧と同様 `innerHTML` を使うが、
チャンネル名は外部由来の文字列であるため、`textContent` 経由で要素を組み立てるか
エスケープしてから埋め込む。

## 国際化

`_locales/{ja,en,es,hi,id,pt}/messages.json` に以下のキーを追加する。
既存ファイルのキー命名（キャメルケース）に揃える。

- `filterSectionTitle` — 「変換対象」
- `filterModeAll` — 「全配信で変換」
- `filterModeAllow` — 「許可リストの配信のみ」
- `filterModeBlock` — 「除外リスト以外で変換」
- `currentBroadcaster` — 「現在の配信者」
- `broadcasterNotDetected` — 「配信を検出できません」
- `addToList` — 「このチャンネルを追加」
- `removeFromList` — 「このチャンネルを解除」
- `allowListTitle` — 「許可リスト」
- `blockListTitle` — 「除外リスト」
- `listEmpty` — 「登録されているチャンネルはありません」
- `targetChannelsTab` — 「対象配信者」

`ja` を原文とし、他言語はそれに対応する訳を入れる。

## 変更対象ファイル

| ファイル | 変更内容 |
| --- | --- |
| `inject.js` | 配信者ID解決、フィルタ判定、条件付き observer 起動、`restoreAllMessages()` |
| `content.js` | `filterSettingsChanged` の中継、フィルタ設定の読み出し、配信者解決とタブ通知の中継 |
| `background.js` | 動画IDからの配信者解決、`chrome.storage.session` への配信者情報保存、タブ削除時の掃除 |
| `popup.html` / `popup.js` / `popup.css` | 変換対象セクションの追加 |
| `settings.html` / `settings.js` / `settings.css` | 「対象配信者」タブの追加 |
| `_locales/*/messages.json` | 上記メッセージキーの追加 |
| `manifest.json` | バージョンを `1.0.5` に更新 |

新しいパーミッションは不要。`storage` / `tabs` と既存の host permissions で足りる。

## テスト

この拡張機能には自動テストの仕組みがないため、手動で確認する。

1. `filterMode = 'all'`（初期状態）で、従来どおり全配信で変換される
2. `filterMode = 'allow'` かつ許可リストが空のとき、どの配信でも変換されず、
   DevTools の Network に RSS 取得が出ない
3. 視聴中の配信をポップアップから許可リストに追加すると、
   リロードなしでその場で変換が始まる
4. 許可リストから解除すると、その場で元の表示名に戻る
5. `filterMode = 'block'` で除外リストに入れた配信のみ変換されない
6. ポップアップで配信者名が正しく表示される（通常の視聴ページ）
7. ポップアップアウトしたチャット単独タブでも配信者が検出される
8. YouTube Studio のライブ配信チャットでも配信者が検出される
9. 配信ページ以外（YouTube トップなど）でポップアップを開くと
   「配信を検出できません」と表示され、トグルが無効になる
10. 設定ページの「対象配信者」タブでリストの表示と削除ができる

## スコープ外

- チャンネルURL／IDの手入力による登録（ポップアップからのワンクリック登録で足りるため）
- 配信者ごとの表示モード（名前のみ／ハンドルのみ）の個別設定
- リストのインポート／エクスポート
