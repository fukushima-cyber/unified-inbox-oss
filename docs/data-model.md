# 統合受信箱 ER図（実装版）

SQLite の実装スキーマは [`src/store.mjs`](../src/store.mjs) にある。次の図は、実際に作成する14テーブルと関係を示す。

```mermaid
erDiagram
    USERS ||--o{ CONNECTIONS : owns
    USERS ||--o{ SESSIONS : logs_in
    CONNECTIONS ||--o{ CONVERSATIONS : contains
    CONVERSATIONS ||--o{ MESSAGES : contains
    CONNECTIONS ||--o{ INBOUND_EVENTS : deduplicates
    CONVERSATIONS ||--o{ COMMANDS : targets
    COMMANDS ||--o{ ATTEMPTS : records
    USERS ||--o{ AUDIT : records
    CONNECTIONS ||--o| SYNC_STATE : reconciles
    CONNECTIONS ||--o{ CHATWORK_ROOMS : classifies
    CONNECTIONS ||--o{ TEAMS_SUBSCRIPTIONS : renews
    CONNECTIONS ||--o| TEAMS_OAUTH : authorizes

    USERS {
        text id PK
        text email UK
        text token_hash UK
        text password_hash
    }
    INVITATIONS {
        text id PK
        text email
        text token_hash UK
        text expires_at
        text used_at
    }
    SESSIONS {
        text id PK
        text user_id FK
        text token_hash UK
        text expires_at
    }
    CONNECTIONS {
        text id PK
        text user_id FK
        text provider
        text external_account_id
        text status
        text credential
        text webhook_secret
        text bridge_hash
        text last_sync_at
        text last_event_at
        text subscription_status
        text subscription_checked_at
    }
    CONVERSATIONS {
        text id PK
        text user_id FK
        text connection_id FK
        text external_key
        text recipient_ref
        text display_name
        int attention
        text last_message_at
    }
    MESSAGES {
        text id PK
        text user_id FK
        text conversation_id FK
        text external_id
        text sender_name
        text direction
        text body
        text source_at
        text attachments_meta
    }
    INBOUND_EVENTS {
        text id PK
        text user_id FK
        text connection_id FK
        text event_key UK
        text received_at
    }
    COMMANDS {
        text id PK
        text user_id FK
        text conversation_id FK
        text connection_id FK
        text request_id UK
        text recipient_snapshot
        text body
        text body_hash
        text attachments
        text status
        text lease_until
        text error_code
    }
    ATTEMPTS {
        text id PK
        text user_id FK
        text command_id FK
        text outcome
        text evidence
        text started_at
        text finished_at
    }
    AUDIT {
        text id PK
        text user_id FK
        text actor
        text entity_id
        text action
        text at
    }
    SYNC_STATE {
        text connection_id PK,FK
        text user_id FK
        text status
        text last_started_at
        text last_completed_at
        int gap_possible
        int checked_rooms
    }
    CHATWORK_ROOMS {
        text connection_id PK,FK
        text room_id PK
        text user_id FK
        text room_type
        text updated_at
    }
    TEAMS_SUBSCRIPTIONS {
        text connection_id PK,FK
        text chat_id PK
        text user_id FK
        text subscription_id UK
        text expires_at
        text room_type
    }
    TEAMS_OAUTH {
        text connection_id PK,FK
        text user_id FK
        text client_id
        text tenant_id
        text refresh_token
        text expires_at
    }
```

- `user_id` と親IDの複合外部キーで、利用者をまたぐ参照をDB上で拒否する。`COMMANDS` は会話と連携先の組合せも複合外部キーで固定する。
- `CONNECTIONS` の `credential`、`webhook_secret`、`MESSAGES` と `COMMANDS` の `body`、添付ファイル本体と表示メタデータ、`TEAMS_OAUTH.refresh_token` は AES-256-GCM 暗号文。ユーザートークン・LINEブリッジ鍵・送信リース鍵はハッシュのみ保持する。送信結果が確定またはリース切れになると、`COMMANDS.attachments` を消す。
- `INBOUND_EVENTS(connection_id,event_key)`、`MESSAGES(conversation_id,external_id)`、`COMMANDS(user_id,request_id)` が再配信・操作再試行の重複を抑える。
- `COMMANDS.status` は `queued / leased / executing / sent / failed / uncertain`。LINEは `executing` の後、外部画面で確認された時だけ `sent`。リース切れは `uncertain` にし、自動再送しない。
- LINE・Gmail・Messengerブリッジは `CONNECTIONS.bridge_hash` で1連携に1つの現行鍵を持つ。鍵を再発行すると古い鍵は無効になる。GmailのOAuth更新トークンは本人端末のエージェント設定に置き、このDBには保存しない。

構想段階の独立した `LINE_BRIDGE_BINDINGS` は実装では `CONNECTIONS` に統合した。送信コマンドの履歴は `ATTEMPTS` に残す。`SYNC_STATE` に履歴照合の成功・失敗と取りこぼし可能性を記録し、`CHATWORK_ROOMS` でDM判定、`TEAMS_SUBSCRIPTIONS` で購読期限を管理する。公開運用には本文保持期間と削除機能が必要。
