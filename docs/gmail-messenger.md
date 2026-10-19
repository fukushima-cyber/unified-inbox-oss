# Gmail・Messenger連携（検証版）

どちらも受信箱にAPIトークンを入力しない。Gmailは本人端末のエージェントでOAuth認可し、Messengerは本人のブラウザを操作するBotで連携する。現時点の検証は疑似API応答とローカルHTTPまでで、実アカウントによる送受信は未実施。

## Gmail

1. 本人が管理するPC・サーバーで受信箱を起動する。画面の「連携を追加」で `Gmail` を選び、自分のGmailアドレスをIDとして保存する。
2. その連携の「ブリッジ鍵を発行」を押し、一度だけ表示される鍵を本人の端末に控える。再発行すると旧鍵は失効する。
3. 本人のGoogle CloudプロジェクトでGmail APIを有効にし、OAuth同意画面と「デスクトップアプリ」のOAuthクライアントを設定してJSONをダウンロードする。このJSONはGitに追加しない。必要なスコープは `gmail.readonly` と `gmail.send`。Googleの公開アプリ審査や利用制限が適用される場合がある。
4. **本人の端末**で次を実行し、受信箱URLとブリッジ鍵を入力する。表示されたGoogleの認可URLを本人のブラウザで開く。認可後、更新トークンは `secrets/gmail-agent.json`（権限0600）に保存される。

   ```sh
   node scripts/gmail-agent.mjs connect /path/to/desktop-oauth-client.json
   node scripts/gmail-agent.mjs run
   ```

エージェントが動作中、初回は直近7日間の受信箱を最大500件確認し、以後はGmailの履歴IDから約60秒間隔で新着を照合する。処理件数の上限や履歴ID失効で欠落の可能性がある場合は受信箱へ表示する。メッセージの本文は本人所有の受信箱へ転送される。エージェント停止中は同期も返信も進まない。送信APIの応答が不明な場合は自動再送せず「要確認」にする。添付ファイルとHTML本文の完全な再現は未対応で、プレーンテキストまたはGmailのスニペットを表示する。

Googleはデスクトップアプリで[PKCEを使ったOAuth認可](https://developers.google.com/identity/protocols/oauth2/native-app)を案内している。本文の読み取りに必要な [`gmail.readonly` は制限付きスコープ](https://developers.google.com/workspace/gmail/api/auth/scopes)であり、公開アプリでは審査要件がある。外部ユーザー向けOAuth同意画面を「Testing」にしたプロジェクトでは、[更新トークンが通常7日で失効する](https://developers.google.com/identity/protocols/oauth2)。継続利用には各人のGoogle Cloud設定と審査要件を確認する必要がある。履歴IDが失効した場合は[全件再同期が必要](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.history/list)だが、この検証版の再同期は直近7日間に限る。その間に取りこぼした可能性がある場合は元のGmailで確認する。

## Messenger

現在の連携は **本人のブラウザ受信箱** を対象とする。画面で `Messenger（ブラウザ）` を追加し、自分のアカウント識別子を登録してブリッジ鍵を発行する。本人専用のGrok Bot環境でMessengerへログインし、Remote HTTPS MCPのURLを `https://{本人の公開ホスト}/mcp`、Bearer鍵をそのブリッジ鍵にする。

MCPツールは `record_messenger_message`、`claim_reply`、`mark_reply_started`、`report_reply_result`、`report_sync_status`。Botはログイン中の本人と相手を毎回確認する。安定したメッセージIDを取得できない場合、重複候補を無理に同一視しない。返信直前に相手を再確認し、送信後に同じ会話で本文を確認できた時だけ `sent` を報告する。結果が曖昧なら `uncertain` として再クリックしない。画面操作の実動作、既読への影響、Grok Botの対応可否は未検証。

本人のBotへ渡す具体的な手順案は [Messenger Botの実行手順案](messenger-bot-instructions.md)。

Metaの[公式Messenger Platform](https://www.postman.com/meta/messenger-platform-api/documentation/iyp204x/messenger-platform-api)はFacebookページ向けで、Pageアクセストークンと `pages_messaging` 権限を前提にする。このブラウザ連携はMeta公式APIによる個人受信箱アクセスを意味しない。Facebookページ宛メッセージを使いたい場合は、別のPage連携として設計・実装する必要がある。
