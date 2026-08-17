# 運用・開発者向け手順

このファイルは、Bot本体を管理・更新する人向けです。Discordサーバー運営者向けの説明は [README.md](README.md) を参照してください。

## ローカル開発

```powershell
Copy-Item .env.example .env
# .env に DISCORD_TOKEN を設定
npm install
npm test
npm start
```

構文確認:

```powershell
node --check src/index.js
node --check src/progress.js
node --check src/audit.js
```

## Discord Developer Portal

`MESSAGE CONTENT INTENT` を有効にする。使用するGateway Intentは次のとおり。

- `Guilds`
- `GuildMessages`
- `GuildMessageReactions`
- `MessageContent`

Bot招待のscopeは `bot` と `applications.commands`。必要権限は `View Channel`、`Read Message History`、`Send Messages`、`Embed Links` のみ。Administrator権限は付与しない。

## Debian LXCへの初回配置

```bash
apt update
apt install -y ca-certificates curl git
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt install -y nodejs

adduser --system --group --home /opt/discord-emoji-audit emoji-audit
git clone <このBotのリポジトリURL> /opt/discord-emoji-audit/app
cd /opt/discord-emoji-audit/app
npm ci --omit=dev
install -d -o emoji-audit -g emoji-audit /var/lib/discord-emoji-audit
chown -R emoji-audit:emoji-audit /opt/discord-emoji-audit
```

環境ファイル `/etc/discord-emoji-audit.env`:

```ini
DISCORD_TOKEN=Botトークン
DATA_DIR=/var/lib/discord-emoji-audit
EMOJI_NAME_PATTERN=^[a-z0-9_]+$
```

```bash
chown root:root /etc/discord-emoji-audit.env
chmod 600 /etc/discord-emoji-audit.env
```

systemdユニット `/etc/systemd/system/discord-emoji-audit.service`:

```ini
[Unit]
Description=Discord Emoji Audit Bot
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=emoji-audit
Group=emoji-audit
WorkingDirectory=/opt/discord-emoji-audit/app
EnvironmentFile=/etc/discord-emoji-audit.env
ExecStart=/usr/bin/node /opt/discord-emoji-audit/app/src/index.js
Restart=on-failure
RestartSec=10
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ReadWritePaths=/var/lib/discord-emoji-audit

[Install]
WantedBy=multi-user.target
```

```bash
systemctl daemon-reload
systemctl enable --now discord-emoji-audit
journalctl -u discord-emoji-audit -f
```

`discord-printer-bot`や動画処理と同じProxmoxホストに置く場合も、専用LXC・専用ユーザー・専用systemdサービスで分離する。

## 更新手順

リポジトリはサービスユーザー所有のため、Git操作はrootで実行する。

```bash
sudo systemctl stop discord-emoji-audit

sudo git -c safe.directory=/opt/discord-emoji-audit/app \
  -C /opt/discord-emoji-audit/app pull --ff-only origin main

sudo npm ci --omit=dev
sudo chown -R emoji-audit:emoji-audit /opt/discord-emoji-audit
sudo systemctl restart discord-emoji-audit

sudo systemctl status discord-emoji-audit --no-pager
sudo journalctl -u discord-emoji-audit -n 50 --no-pager
```

コミット確認:

```bash
sudo git -c safe.directory=/opt/discord-emoji-audit/app \
  -C /opt/discord-emoji-audit/app log -1 --oneline
```

## データとバックアップ

`DATA_DIR`の既定値は`./data`。LXCでは通常`/var/lib/discord-emoji-audit`を使う。

- `audit.json`: 確定済み集計
- `audit.json.bak`: 保存時バックアップ
- `scan-<guildId>-<runId>.json`: 初期走査チェックポイント
- `scan-live-<guildId>.jsonl`: 走査中の未反映イベント
- `*.orphan`: 新しい走査開始時に退避されたイベントログ

更新前にこれらをLXC外へバックアップする。Proxmoxバックアップまたはホスト側の世代バックアップも設定する。データ形式を変更する場合は、複製データでテストと復元確認を行う。

## 走査の仕様

- 現在登録中の資産を走査開始時に確定する
- 本文、スタンプ、リアクションを日別集計する
- 一時的なAPI失敗は再試行する
- 権限不足・削除済みなど恒久的に取得できない範囲は対象外として記録する
- 取得可能な範囲をすべて処理した場合のみ確定済み集計へ反映する
- 走査中に発生したライブイベントは、重複の可能性がある場合に未反映として保留する
- 同一`DATA_DIR`で複数プロセスを起動しない。ファイルロックで二重起動を防止する

## リリース前確認

```powershell
node --check src/index.js
node --check src/progress.js
node --check src/audit.js
npm test
git diff --check
```

小さいテストサーバーで`/scan`を実行し、進捗メッセージの編集、絵文字の実物表示、スタンプ画像、完了時の新規投稿、エラー時の既存データ維持を確認してから本番サーバーへ反映する。

## 障害確認

```bash
sudo systemctl status discord-emoji-audit --no-pager
sudo journalctl -u discord-emoji-audit -n 100 --no-pager
```

`Error: Used disallowed intents` が出た場合は、Developer Portalで`MESSAGE CONTENT INTENT`を確認する。`dubious ownership`や`.git/FETCH_HEAD: Permission denied`が出た場合は、上記のroot実行更新手順を使う。
