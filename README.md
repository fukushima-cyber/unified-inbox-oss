# 統合受信箱（検証版）

ライセンス: [MIT](LICENSE)。各人が自分のPC・サーバーで動かすためのソースコードです。

個人LINE・Slack・Chatwork・Teams・Gmail・Messengerの会話と返信要求を一画面で扱う検証版。Gmailは本人端末のOAuthエージェント、Messengerは本人のブラウザを操作するBotのブリッジを追加した。ローカルの疑似イベントとGmail API応答を使ったテストは通過したが、Gmail・Messengerの実アカウントでの一往復は未確認。公開配布用の完成版ではない。

**作成者が資格情報を預からない配布方法は、利用者それぞれが自分のPC・サーバーでインスタンスを運用すること。** `setup.sh` は新規インスタンスに所有者メールアドレスを設定し、別利用者の追加を拒否する。共通サーバーを作成者が運用すると、既存のSlack・Chatwork・Teamsの資格情報や保存した本文を管理者が復号できる。詳細は [資格情報の保管と配布](docs/credential-custody.md)。

## 起動

手元のPCで試す場合はNode.js 22.16以降とOpenSSLが必要。依存パッケージのインストールは不要。PCのブラウザで受信箱を使うだけなら公開ドメインは不要。Gmailエージェントも同じPCで動かせる。一方、Slack・Chatwork・TeamsのWebhookとGrok BotのRemote HTTPS MCPを使うには、そのPCの受信箱へ外部から到達できるHTTPS URLが必要。PCを停止・スリープすると受信・返信処理も止まる。

```sh
./setup.sh you@example.com
```

引数なしの `./setup.sh` でも対話入力できる。コマンドはマスター鍵と所有者を保存して招待コードを発行し、`http://127.0.0.1:8787` でサーバーを起動する。終了は Ctrl+C。再実行しても鍵とDBを保持する。初回設定前の招待コードだけは再発行され、古いコードは失効する。パスワード登録済みなら新しいコードを発行しない。

本人は表示URLの「招待コードで初回設定」から12文字以上のパスワードを登録し、以後はメールアドレスとパスワードでログインする。ブラウザには有効期限7日のHttpOnlyセッションCookieを使う。別の人は自分の端末・サーバーに別インスタンスを起動する。メール送信とパスワードのセルフリセットは未実装で、再設定には所有者による新しい招待が必要。

マスター鍵は `secrets/inbox_master_key`、ローカルDBは `inbox.sqlite` に保存される。両方を保全する。鍵を失うと暗号化した本文・連携資格情報を読めない。既存DBがあるのに鍵がない場合、セットアップは停止する。

公開ドメインとDocker Composeを使う場合は [本人所有サーバーでの起動手順](docs/deployment.md) を参照。`./setup.sh you@example.com inbox.example.com` でHTTPS起動する。ドメインとサーバーは利用者自身が用意する必要がある。

環境変数: `INBOX_DB`（DBパス）、`PORT`（既定8787）、`INBOX_HOST`（既定127.0.0.1）、`INBOX_PUBLIC_ORIGIN`（公開HTTPSのオリジン。Teams通知購読のURLとMCPのOrigin検証に使用）、`INBOX_MAX_MESSAGES_PER_USER`（既定10000）、`INBOX_MAX_EVENTS_PER_USER`（既定20000）、`INBOX_MAX_COMMANDS_PER_USER`（既定10000）。ローカルサーバーはTLSを持たない。外部公開ではHTTPSリバースプロキシが必須で、`INBOX_HOST` をループバック以外にするにはHTTPSの `INBOX_PUBLIC_ORIGIN` が必要。Cookieは公開HTTPS時にSecure属性を付ける。

## 連携の作り方

画面の「連携を追加」で、自分のサービスIDと表示名を登録する。Slack・Chatwork・Teamsは登録時にサービスの `/me` または `auth.test` でトークンの本人IDを照合し、資格情報を本人所有のサーバーにAES-256-GCMで暗号化保存する。LINE・Gmail・MessengerのAPI資格情報は受信箱に入力できない。Gmailは本人端末でOAuth認可し、Messengerは本人のBot環境でブラウザへログインする。

| サービス | 自分のID | 送信資格情報 | Webhook秘密値 | 通知URL |
|---|---|---|---|---|
| LINE | Botで確認する本人識別子 | 不要 | 不要 | `/mcp` または `/api/bridge/*` |
| Slack | `auth.test` の `user_id` | 本人のユーザートークン | AppのSigning Secret | `/webhooks/slack/{connectionId}` |
| Chatwork | `/me` の `account_id` | APIトークン | Webhookトークン（Base64） | `/webhooks/chatwork/{connectionId}` |
| Teams | Graph `/me` の `id` | 委任アクセストークン | Graph購読の `clientState` | `/webhooks/teams/{connectionId}` |
| Gmail | 本人のメールアドレス | 本人端末のOAuthエージェントに保存 | 不要 | `/api/bridge/*` |
| Messenger（ブラウザ） | 本人の識別子 | 不要 | 不要 | `/mcp` または `/api/bridge/*` |

Slackでは Events API の `message.im` やメンション通知を設定し、送信に必要な権限を付ける。現状の接続URLは連携ごとに異なるため、各利用者が別々のSlack Appを設定する前提。共通Appから複数利用者へ通知を振り分けるOAuth構成は未実装。ChatworkはWebhookを設定する。Teamsは `INBOX_PUBLIC_ORIGIN` を設定すると、対象チャットごとの Graph 変更通知購読を定期的に作成・更新する。期限や失敗は連携欄に表示する。各サービスのOAuth認可画面と自動トークン更新は未実装で、画面から資格情報を更新する。Teamsの委任アクセストークンは期限切れで連携が止まるため、現段階で常時運用できない。ChatworkとTeamsは単一プロセスのジョブが順番に履歴を照合し（少数利用者では約5分間隔を目標）、取得上限に達した場合は不足の可能性を表示する。

GmailとMessengerの設定手順は [Gmail・Messenger連携](docs/gmail-messenger.md) を参照。Gmailのエージェントは起動中に約60秒間隔で履歴を照合し、返信要求を処理する。停止中は同期しない。Messengerのブラウザ操作は、本人のBotでの実動作をまだ検証していない。

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
2. Gmailの本人所有Google CloudプロジェクトでOAuth認可・受信・返信・更新トークンの実動作を確認する。Googleのスコープ審査や利用制限を確認する。
3. Slack・TeamsのOAuthと自動トークン更新を実装し、実アカウントで通知購読と送受信を検証する。Chatworkの資格情報も実アカウントで確認する。
4. Slackの履歴照合を設計・実装する。Chatworkの直近100件制限とTeamsの取得上限を越えた場合の欠落を運用で検知する。
5. 本文保持期間・削除と上限到達時の復旧手順、公開側のレート制限を整える。現状は上限到達で新着受信が停止し、利用者へエラーを表示する。
6. [本人所有サーバーでの起動手順](docs/deployment.md)を実環境で検証し、復旧テストを行う。

`node --test tests/*.test.mjs` でローカルのDB・HTTP・MCP・署名検証テストを実行できる。詳細は [再レビュー](docs/review.md)、[設計](docs/architecture.md)、[ER図](docs/data-model.md)。
