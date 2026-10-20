# 統合受信箱（検証版）

ライセンス: [MIT](LICENSE)。各人が自分のPC・サーバーで動かすためのソースコードです。

個人LINE・Slack・Chatwork・Teams・Gmail・Messengerの会話と返信要求を一画面で扱う検証版。Gmailは本人端末のOAuthエージェント、Teamsは本人管理のEntraアプリによるOAuth、Messengerは本人のブラウザを操作するBotのブリッジを備える。開発環境でGmailのOAuth・受信、ChatworkのAPI認証・受信を実アカウントで確認した。送信の実アカウント検証とLINE・Messengerの実連携は未完了。公開配布用の完成版ではない。


**作成者が資格情報を預からない配布方法は、利用者それぞれが自分のPC・サーバーでインスタンスを運用すること。** `setup.sh` は新規インスタンスに所有者メールアドレスを設定し、別利用者の追加を拒否する。共通サーバーを作成者が運用すると、既存のSlack・Chatwork・Teamsの資格情報や保存した本文を管理者が復号できる。詳細は [資格情報の保管と配布](docs/credential-custody.md)。

## 起動

手元のPCで試す場合はNode.js 22.16以降とOpenSSLが必要。依存パッケージのインストールは不要。Slack・Chatwork・Teamsの定期照合とGmailエージェントには公開ドメインは不要。Webhookの即時通知とGrok BotのRemote HTTPS MCPを使う場合だけ、外部から到達できるHTTPS URLが必要。PCを停止・スリープすると受信・返信処理も止まる。

```sh
./setup.sh you@example.com
```

引数なしの `./setup.sh` でも対話入力できる。コマンドはマスター鍵と所有者を保存して招待コードを発行し、`http://127.0.0.1:8787` でサーバーを起動する。Gmailを設定済みなら同じコマンドで同期エージェントも起動する。終了は Ctrl+C。再実行しても鍵とDBを保持する。初回設定前の招待コードだけは再発行され、古いコードは失効する。パスワード登録済みなら新しいコードを発行しない。

本人は表示URLの「招待コードで初回設定」から12文字以上のパスワードを登録し、以後はメールアドレスとパスワードでログインする。ブラウザには有効期限7日のHttpOnlyセッションCookieを使う。別の人は自分の端末・サーバーに別インスタンスを起動する。メール送信とパスワードのセルフリセットは未実装で、再設定には所有者による新しい招待が必要。

マスター鍵は `secrets/inbox_master_key`、ローカルDBは `inbox.sqlite` に保存される。両方を保全する。鍵を失うと暗号化した本文・連携資格情報を読めない。既存DBがあるのに鍵がない場合、セットアップは停止する。

公開ドメインとDocker Composeを使う場合は [本人所有サーバーでの起動手順](docs/deployment.md) を参照。`./setup.sh you@example.com inbox.example.com` でHTTPS起動する。ドメインとサーバーは利用者自身が用意する必要がある。

環境変数: `INBOX_DB`（DBパス）、`PORT`（既定8787）、`INBOX_HOST`（既定127.0.0.1）、`INBOX_PUBLIC_ORIGIN`（公開HTTPSのオリジン。Teams通知購読のURLとMCPのOrigin検証に使用）、`INBOX_MAX_MESSAGES_PER_USER`（既定10000）、`INBOX_MAX_EVENTS_PER_USER`（既定20000）、`INBOX_MAX_COMMANDS_PER_USER`（既定10000）。ローカルサーバーはTLSを持たない。外部公開ではHTTPSリバースプロキシが必須で、`INBOX_HOST` をループバック以外にするにはHTTPSの `INBOX_PUBLIC_ORIGIN` が必要。Cookieは公開HTTPS時にSecure属性を付ける。

## 連携の作り方

画面は「要対応 → 会話確認 → 返信先と本文・添付の確認 → 送信結果の確認」の順で使う。状態別件数、サービス別絞り込み、相手・件名・宛先の検索、スマホ幅の一覧／詳細切替を備える。全会話数と過去7日の受信・返信数、サービス別会話数を表示し、繰り返し受信や要対応件数から定型返信・通知整理の候補をこのPC内で提案する。提案は自動実行しない。連携設定は左メニュー下部にまとめた。操作と状態表示の詳細は [受信箱の操作設計](docs/ui-ux.md) を参照。

返信へのファイル添付はGmail・Chatwork・Slackに対応する。1ファイル4MB、合計6MB、最大3件（Chatworkは1件）。送信待ち中は本人のDBに暗号化し、送信結果が確定するとファイル本体を削除して名称とサイズだけを履歴に残す。Gmailは本人端末のエージェントがMIME添付として送信する。Chatworkはファイルアップロード時のメッセージ欄で本文を同時送信する。Slackはファイルアップロードと共有APIを使い、ユーザートークンに `files:write` が必要。Teams・個人LINE・Messengerの添付送信は未対応と表示する。外部サービスへの添付実送信はまだ検証していない。

画面の「連携を追加」で、自分のサービスIDと表示名を登録する。Slack・Chatwork・Teamsの手動登録はサービスの `/me` または `auth.test` でトークンの本人IDを照合し、資格情報を本人所有のサーバーにAES-256-GCMで暗号化保存する。Teamsは画面の「Teamsを接続」からOAuthデバイス認証すると更新トークンも本人のDBに暗号化保存し、自動更新する。LINE・Gmail・MessengerのAPI資格情報は受信箱に入力できない。

| サービス | 自分のID | 送信資格情報 | Webhook秘密値 | 通知URL |
|---|---|---|---|---|
| LINE | Botで確認する本人識別子 | 不要 | 不要 | `/mcp` または `/api/bridge/*` |
| Slack | `auth.test` の `user_id` | 本人のユーザートークン | AppのSigning Secret（Webhook時） | `/webhooks/slack/{connectionId}` |
| Chatwork | `/me` の `account_id` | APIトークン | Webhookトークン（Webhook時） | `/webhooks/chatwork/{connectionId}` |
| Teams | Graph `/me` の `id` | 本人OAuth、または委任アクセストークン | Graph購読の `clientState`（Webhook時） | `/webhooks/teams/{connectionId}` |
| Gmail | 本人のメールアドレス | 本人端末のOAuthエージェントに保存 | 不要 | `/api/bridge/*` |
| Messenger（ブラウザ） | 本人の識別子 | 不要 | 不要 | `/mcp` または `/api/bridge/*` |

### Teamsを本人のアカウントで接続

1. 本人または所属組織が管理する[Microsoft Entraのアプリ登録](https://learn.microsoft.com/ja-jp/entra/identity-platform/quickstart-register-app)を作成する。アカウント種別は所属ディレクトリのみにする。
2. Microsoft Graphの委任権限 `User.Read`、`Chat.Read`、`ChatMessage.Send` を登録し、認証画面の「パブリック クライアント フローを許可」を有効にする。組織が管理者承認を要求する場合は、その承認が必要。
3. 受信箱の「連携を追加」でTeamsを選び、下の「Teamsを接続」にアプリIDとディレクトリIDを入力する。表示されたMicrosoft認証ページでコードを入力し、要求権限を確認する。
4. 受信箱の連携欄が「最終同期」と表示されるまで待つ。OAuth更新トークンは本人のDBに暗号化保存される。公開URLがなければ定期照合で受信する。

Slackは本人のユーザートークンで `search.messages` を使い、DMと本人へのメンションを約5分間隔で照合する。必要なユーザースコープは `search:read` と `chat:write`、添付送信には `files:write`。検索結果の上限や検索設定により欠落の可能性があるため、接続状態に表示する。Webhookで即時通知する場合は別途 Events API の `message.im`・`app_mention` とSigning Secretが必要。Chatworkは最大40室ずつ巡回し、各室の直近100件を照合する。Teamsもチャット履歴を定期照合する。公開URLを設定した場合だけTeamsのGraph通知購読を作成する。TeamsのOAuthには本人のEntraアプリで `User.Read`、`Chat.Read`、`ChatMessage.Send`、`offline_access` の委任権限とパブリッククライアントフローが必要。組織の管理者承認が必要な場合がある。

GmailとMessengerの設定手順は [Gmail・Messenger連携](docs/gmail-messenger.md) を参照。画面左の「Gmailを使い始める」に本人用の接続手順を表示する。Gmailのエージェントは起動中に約60秒間隔で履歴を照合し、返信要求を処理する。停止中は同期しない。Gmailは初回同期前または15分以上同期が止まった場合、返信要求を登録できない。Messengerのブラウザ操作は、本人のBotでの実動作をまだ検証していない。

## Grok Bot と個人LINE

LINE連携を追加した本人が「ブリッジ鍵を発行」し、その鍵を本人専用のGrok BotのRemote HTTPS MCPに設定する。MCP URLは `https://{公開ホスト}/mcp`。鍵はHTTP Bearerとして渡す。MCPは `record_line_message`、`claim_reply`、`mark_reply_started`、`report_reply_result` の4ツールを提供する。一時HTTPS MCPではGrok BotからBearer認証付きのツール呼び出しを実測済み。実際の受信箱MCPとの接続は未検証。鍵の再発行は旧鍵を失効させる。

Botの手順は次のとおり。

1. Chrome版LINEのログイン中の本人アカウントを確認し、新着の宛先・相手・本文・時刻を読み取る。安定したイベントIDがない場合は重複候補を無理に同一視しない。
2. `record_line_message` に会話識別子、宛先参照、本文、イベントキーを渡す。画面を開くと既読になる可能性を実機確認する。
3. `claim_reply` で一件受け取ったら、ログイン中の本人と会話相手を再確認する。同名で区別不能なら送らず `uncertain` で報告する。
4. 実際の送信操作に入る直前に `mark_reply_started`。送信後、同じ相手の会話内で正しい本文が見えた場合に限り `report_reply_result(status=sent, recipientVerified=true, messageVisible=true, evidence=...)`。結果が曖昧なら `uncertain`。再クリックしない。

LINEには送信元の冪等キーがない。サーバーはリース期限切れを `uncertain` にし、二重送信を防ぐ方向で停止する。真の一回送信保証はない。Grok Botの定期ルーチンは最短5分間隔なので即時通知は保証しない。

## 実装済みの保護

- 招待制の本人別ログイン、scryptで保存したパスワード、有効期限付きHttpOnlyセッション。既存APIトークンは移行用に維持。DBの複合外部キーでも利用者をまたぐ会話・送信参照を拒否。
- SlackとChatworkのWebhook署名検証、Teamsの `clientState` 検証。
- 受信イベント・外部メッセージ・返信要求の重複排除。
- 送信宛先の固定、LINEの一件リース、送信結果不明時の自動再送停止。
- 返信本文と連携資格情報の暗号化、鍵・トークンのハッシュ保存。
- 会話一覧と会話内メッセージを各50件ずつ取得し、必要な分だけ続きを表示。利用者別の保存上限を超えた受信はエラーにし、連携欄に表示する。自動削除は行わない。

## 公開前に残る作業

1. Grok Botの実アカウントでLINEとMessengerの受信箱MCPとの一往復、画面観測の安定ID、返信確認、既読影響を実測する。
2. Gmailの返信を実アカウントで確認する。Googleのスコープ審査や利用制限を確認する。
3. Slack・Teamsの実アカウント接続と送受信を検証する。Slackのユーザートークン自動更新は未実装。
4. Slack検索結果、Chatworkの直近100件制限とTeamsの取得上限を越えた場合の欠落を運用で検知する。
5. 本文保持期間・削除と上限到達時の復旧手順、公開側のレート制限を整える。現状は上限到達で新着受信が停止し、利用者へエラーを表示する。
6. [本人所有サーバーでの起動手順](docs/deployment.md)を実環境で検証し、復旧テストを行う。

`node --test tests/*.test.mjs` でローカルのDB・HTTP・MCP・署名検証テストを実行できる。詳細は [再レビュー](docs/review.md)、[設計](docs/architecture.md)、[ER図](docs/data-model.md)。
