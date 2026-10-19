#!/bin/sh
set -eu
umask 077
cd "$(dirname "$0")"

fail() { printf '%s\n' "エラー: $*" >&2; exit 1; }
usage() { printf '%s\n' '使い方: ./setup.sh [初回利用者のメールアドレス] [公開ドメイン]'; exit 2; }
[ "$#" -le 2 ] || usage

email=${1:-}
domain=${2:-}
if [ -z "$email" ]; then
 [ -t 0 ] || usage
 printf '初回利用者のメールアドレス: '
 IFS= read -r email
 printf '公開ドメイン（手元で試す場合は空欄）: '
 IFS= read -r domain
fi
case "$email" in
  *@*.*) ;;
  *) fail 'メールアドレスを確認してください' ;;
esac
case "$email" in
  *[!a-zA-Z0-9._%+@-]*|*@*@*|.*|*..*|*@.*|*.) fail 'メールアドレスを確認してください' ;;
esac
email=$(printf '%s' "$email" | tr '[:upper:]' '[:lower:]')

if [ -n "$domain" ]; then
 printf '%s\n' "$domain" | LC_ALL=C awk '
  length($0)>253 || NF<2 {exit 1}
  {for(i=1;i<=NF;i++) if(length($i)<1 || length($i)>63 || $i !~ /^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?$/) exit 1}
 ' FS=. || fail 'ドメインだけを指定してください（https:// は不要）'
 command -v docker >/dev/null 2>&1 || fail 'Docker Compose が必要です'
 docker compose version >/dev/null 2>&1 || fail 'Docker Compose が必要です'
 docker info >/dev/null 2>&1 || fail 'Dockerを起動してください'
 command -v curl >/dev/null 2>&1 || fail 'curl が必要です'
 if [ -e .env ] || [ -L .env ]; then
  [ ! -L .env ] || fail '.env がシンボリックリンクです'
  configured=$(sed -n 's/^INBOX_DOMAIN=//p' .env)
  [ "$configured" = "$domain" ] || fail '.env のドメインが指定値と異なります'
  configured_owner=$(sed -n 's/^INBOX_OWNER_EMAIL=//p' .env)
  [ "$configured_owner" = "$email" ] || fail '.env の所有者が異なるか未設定です。旧共有構成は個人用へ手動移行してください'
 fi
else
 command -v node >/dev/null 2>&1 || fail 'Node.js 22.16以降が必要です'
 node -e 'const v=process.versions.node.split(".").map(Number);process.exit(v[0]>22 || v[0]===22 && v[1]>=16 ? 0 : 1)' || fail 'Node.js 22.16以降が必要です'
 [ ! -e .env ] && [ ! -L .env ] || fail '公開用の .env があります。公開ドメインを指定してください'
fi
command -v openssl >/dev/null 2>&1 || fail 'openssl が必要です'
[ ! -L secrets ] || fail 'secrets がシンボリックリンクです'
[ ! -L secrets/inbox_master_key ] || fail 'マスター鍵がシンボリックリンクです'
[ ! -L secrets/owner_email ] || fail '所有者設定がシンボリックリンクです'
[ ! -e secrets ] || [ -d secrets ] || fail 'secrets がディレクトリではありません'
if [ -z "$domain" ] && [ -e secrets/owner_email ]; then
 [ "$(cat secrets/owner_email)" = "$email" ] || fail 'このインスタンスの所有者は別のメールアドレスです'
fi

if [ ! -e secrets/inbox_master_key ]; then
 if [ -e inbox.sqlite ] || [ -e inbox.sqlite-wal ] || [ -e inbox.sqlite-shm ] || [ -e .env ]; then
  fail '既存データまたは設定があるのにマスター鍵がありません。元の鍵を復元してください'
 fi
 if [ -n "$domain" ]; then
  project=$(INBOX_DOMAIN="$domain" docker compose config --format json | sed -n 's/^[[:space:]]*"name": "\([^"]*\)",$/\1/p' | head -n 1)
  [ -n "$project" ] || fail 'Composeのプロジェクト名を確認できません'
  if docker volume inspect "${project}_inbox_data" >/dev/null 2>&1; then
   fail '既存のDockerデータがあるのにマスター鍵がありません。元の鍵を復元してください'
  fi
 fi
 mkdir -p secrets
 chmod 700 secrets
 tmp=$(mktemp secrets/.inbox_master_key.XXXXXX)
 trap 'rm -f "$tmp"' EXIT HUP INT TERM
 openssl rand -hex 32 > "$tmp"
 chmod 600 "$tmp"
 ln "$tmp" secrets/inbox_master_key || fail 'マスター鍵の作成に失敗しました'
 rm -f "$tmp"
 trap - EXIT HUP INT TERM
fi
key=$(cat secrets/inbox_master_key)
case "$key" in
  *[!0-9a-fA-F]*|'') fail 'マスター鍵の形式が不正です' ;;
esac
[ "${#key}" -eq 64 ] || fail 'マスター鍵の形式が不正です'
unset key
chmod 700 secrets
# Compose mounts file-backed secrets without remapping their owner or mode.
# The host directory remains owner-only; the non-root app can read the mounted file.
if [ -n "$domain" ]; then chmod 644 secrets/inbox_master_key; else chmod 600 secrets/inbox_master_key; fi

if [ -z "$domain" ] && [ ! -e secrets/owner_email ]; then
 if [ -e inbox.sqlite ]; then node scripts/check-personal-owner.mjs "$email" || fail '既存DBを個人用にできません'; fi
 tmp=$(mktemp secrets/.owner_email.XXXXXX)
 trap 'rm -f "$tmp"' EXIT HUP INT TERM
 printf '%s\n' "$email" > "$tmp"
 chmod 600 "$tmp"
 ln "$tmp" secrets/owner_email || fail '所有者設定の作成に失敗しました'
 rm -f "$tmp"
 trap - EXIT HUP INT TERM
fi

if [ -n "$domain" ]; then
 if [ ! -e .env ]; then
  tmp=$(mktemp .env.XXXXXX)
  trap 'rm -f "$tmp"' EXIT HUP INT TERM
  printf 'INBOX_DOMAIN=%s\nINBOX_OWNER_EMAIL=%s\n' "$domain" "$email" > "$tmp"
  chmod 600 "$tmp"
  ln "$tmp" .env || fail '.env の作成に失敗しました'
  rm -f "$tmp"
  trap - EXIT HUP INT TERM
 fi
 export INBOX_DOMAIN=$domain
 export INBOX_OWNER_EMAIL=$email
 docker compose up -d --build --wait --wait-timeout 120 || fail 'コンテナを起動できませんでした。docker compose logs を確認してください'
 url=https://$domain
 ready=no
 for attempt in 1 2 3 4 5 6 7 8 9 10 11 12; do
  if curl --fail --silent --show-error --max-time 5 "$url/health" 2>/dev/null | grep -q '"ok":true'; then ready=yes; break; fi
  sleep 5
 done
 [ "$ready" = yes ] || fail '公開HTTPSを確認できません。DNS・80/443・Caddyログを確認して再実行してください'
 printf 'URL: %s\n' "$url"
 docker compose exec -T app node scripts/setup-invite.mjs "$email"
else
 export INBOX_MASTER_KEY_FILE="$(pwd -P)/secrets/inbox_master_key"
 export INBOX_DB="$(pwd -P)/inbox.sqlite"
 export INBOX_HOST=127.0.0.1
 export INBOX_OWNER_EMAIL=$email
 unset INBOX_PUBLIC_ORIGIN
 port=${PORT:-8787}
 case "$port" in *[!0-9]*|'') fail 'PORTには1〜65535を指定してください' ;; esac
 [ "$port" -ge 1 ] && [ "$port" -le 65535 ] || fail 'PORTには1〜65535を指定してください'
 PORT=$port node -e 'const net=require("node:net");const s=net.createServer();s.once("error",()=>process.exit(1));s.listen(Number(process.env.PORT),"127.0.0.1",()=>s.close())' || fail "ポート $port を使用できません"
 printf 'URL: http://127.0.0.1:%s\n' "$port"
 node scripts/setup-invite.mjs "$email"
 printf '%s\n' '受信箱を起動します。Gmail設定があれば同期も自動起動します。終了するには Ctrl+C。'
 exec node scripts/local-run.mjs
fi
