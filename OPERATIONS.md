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
node --check src/message-events.js
node --check src/ranking.js
```

## Discord Developer Portal

`MESSAGE CONTENT INTENT` を有効にする。使用するGateway Intentは次のとおり。

- `Guilds`
- `GuildMessages`
- `GuildMessageReactions`
- `MessageContent`

Bot招待のscopeは `bot` と `applications.commands`。必要権限は `View Channel`、`Read Message History`、`Send Messages`、`Embed Links`、`Connect`。Administrator権限は付与しない。

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
BOT_OWNER_USER_IDS=追加の運用者IDをカンマ区切りで指定
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

- `/scan` は現在取得できるDiscord履歴から日次集計を再構築する。過去の確定済み日次集計を累積して足し合わせる処理ではない
- `/scan` はサーバー管理者、Discord ApplicationのBot所有者、`BOT_OWNER_USER_IDS`、または指定運用者`363466015683903488`だけが実行できる。`/report`は全員が実行可能
- `/scan limit:N` は上位・下位の表示順位を指定する（1〜100）。指定順位が同率なら同率の資産をすべて表示し、省略時は10位
- 完了通知と `/report` には、前回スキャン時の日数（通常スキャンは直近30日）による全順位を、絵文字・スタンプ別に最下位から表示する。全順位一覧には `limit` を適用しない
- `/scan channels:<ID/メンション>` は対象チャンネルをカンマ区切りで複数指定でき、省略時は全チャンネルを対象にする。指定チャンネルのスレッドも含める
- `/report channels:<同じ指定>` は対象範囲ごとの最新スナップショットを再表示する
- `/scan exclude_bots:true` はBot送信メッセージとそのメッセージへのリアクションを除外する
- `/scan channels` と `exclude_channels` は同時指定できない
- `/scan exclude_channels` はチャンネルIDまたはメンションをカンマ区切りで複数指定でき、指定チャンネルのスレッドも除外する
- `/scan only_me:true` は進捗と完了・失敗報告を実行者だけへ表示する。`/report only_me:true` は結果だけを非公開表示する
- 現在登録中の資産を走査開始時に確定する
- 本文、スタンプ、リアクションを日別集計する
- 全体合算とチャンネル別の日別集計を保存し、対象範囲ごとに最新1件を保持する
- Bot自身のメッセージ、編集、リアクションは集計しない。`exclude_bots:true` 指定時は他のBotも除外する
- 一時的なAPI失敗は1チャンネルあたり最大10回再試行し、上限到達時は取得不能として部分完了にする
- 権限不足・取得不能など恒久的に取得できない範囲は対象外として記録する
- private archived thread の全件取得には `Manage Threads` が必要だが、最小権限のため要求しない
- 音声チャンネル内のテキストチャットも走査対象とし、`Connect` 権限を必要とする
- 取得可能な範囲をすべて処理した場合のみ確定済み集計へ反映する
- 走査中に発生したライブイベントは、重複の可能性がある場合に未反映として保留する
- 同一`DATA_DIR`で複数プロセスを起動しない。ファイルロックで二重起動を防止する

## リリース前確認

```powershell
node --check src/index.js
node --check src/progress.js
node --check src/audit.js
node --check src/message-events.js
node --check src/ranking.js
node --check src/scopes.js
node --check src/authorization.js
node --check src/discord-contract.js
node --check src/scan-config.js
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
