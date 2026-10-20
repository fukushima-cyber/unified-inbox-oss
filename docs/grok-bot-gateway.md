# ローカル受信箱をGrok Botへつなぐ

受信箱を `127.0.0.1:8787` で起動したまま、別のターミナルで `node scripts/mcp-gateway.mjs` を実行する。ゲートウェイは `127.0.0.1:8788` に待ち受け、Bearer鍵を持つ `POST /mcp` だけを受信箱へ転送する。受信箱の画面、Gmail、Slack、Chatwork、TeamsのAPIは転送しない。受信箱のログインを省略したローカルモードでも、MCPは連携別のブリッジ鍵で認証する。

Grok BotのRemote HTTPS MCPがローカルPCへ到達できるよう、本人が管理するHTTPSトンネルの転送先を `http://127.0.0.1:8788` に指定する。たとえばCloudflare Quick Tunnelなら `cloudflared tunnel --url http://127.0.0.1:8788`。発行されたHTTPS URLの末尾に `/mcp` を付け、Grok BotのMCP設定に登録する。Cloudflare側の一時URLは再起動で変わり得るため、その場合はBot側の設定も更新する。端末を閉じると連携は止まる。

受信箱で個人LINEまたはMessengerを追加し、対象連携の「ブリッジ鍵を発行」で表示される鍵を、その連携専用のGrok Bot MCP設定にBearer鍵として登録する。鍵の再発行で旧鍵は失効する。LINEとMessengerは別々の鍵とMCP設定にする。BotへブラウザのCookie、パスワード、二要素認証コードを渡さない。

ゲートウェイは受信したCookieとOriginを転送せず、MCP本文・鍵をログに出さない。トンネルの公開URLを知った第三者も鍵がなければMCPを呼べない。Grok Botへ鍵を登録すると、そのBotは対象サービスの受信データ登録と返信要求の取得・実行結果報告ができる。Bot側のログイン中アカウントと受信箱の連携IDが一致することを、実データを転送する前に確認する。
