# 本人用Messenger Botの実行手順案

この文書は本人が自分のGrok Botに渡す手順案。実ブラウザでの動作は未検証。Botの実行環境でログイン中のFacebookアカウントが、受信箱に登録した本人の識別子と一致することを先に確認する。一致しない、確認できない、ログイン画面へ戻った場合は操作を止め、`report_sync_status` にエラーを報告する。Cookie・パスワード・二要素認証コードはMCPへ送らない。

1. 本人宛の新しい会話を一覧で確認する。会話を開くことで既読が変わる可能性を記録する。相手、会話識別子、本文、時刻を確認できた受信メッセージだけ `record_messenger_message` に登録する。イベントIDが見える場合はそのIDを使う。IDが取れない場合は同じ投稿を安易に重複と判断せず、観測した会話・相手・時刻・本文から再現できるイベントキーを作り、不明点を残す。
2. 観測を終えたら `report_sync_status` を呼ぶ。対象の会話を確認できなかった、画面が変わった、途中で停止した場合は `gapPossible=true` または短い `error` を送る。正常終了を報告できるのは対象範囲を確認した場合だけ。
3. `claim_reply` は一件ずつ実行する。返された `conversation.recipient_ref` と現在の会話相手を照合する。同名や複数の候補で区別できない場合は送信しない。`report_reply_result(status="failed", errorCode="recipient_ambiguous")` を報告する。
4. 本文と相手を確認した直後、送信操作に入る前に `mark_reply_started` を呼ぶ。成功しなければ送信しない。
5. 送信後、同じ相手の同じ会話内に正しい本文が表示された場合だけ `report_reply_result(status="sent", recipientVerified=true, messageVisible=true, evidence="確認した画面上の事実")` を報告する。クリック後に画面・通信・結果が不明なら `status="uncertain"` を報告し、再クリックしない。

MCP URLは本人が管理する `https://{ホスト}/mcp`。Bearer鍵はその本人のMessenger連携から発行したブリッジ鍵を使う。`record_line_message` は別のLINE連携専用であり、この鍵では表示されない。
