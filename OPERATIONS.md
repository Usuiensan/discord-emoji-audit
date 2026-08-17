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
apt install -y ca-certificates curl
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt install -y nodejs

adduser --system --group --home /opt/discord-emoji-audit emoji-audit
install -d -o emoji-audit -g emoji-audit /var/lib/discord-emoji-audit
install -d -o emoji-audit -g emoji-audit /opt/discord-emoji-audit/releases
```

### デプロイヘルパーとsudoersの初回設定

初回だけ、`tools/deploy-debian.sh`の内容を確認してDebianへ転送し、`sudo bash`ではなく固定パスへroot所有で配置する。管理端末からの例:

```powershell
scp -O .\tools\deploy-debian.sh emojiadmin@192.168.68.101:/tmp/discord-emoji-audit-deploy.helper
ssh -t emojiadmin@192.168.68.101 "sudo install -o root -g root -m 0755 /tmp/discord-emoji-audit-deploy.helper /usr/local/sbin/discord-emoji-audit-deploy && sudo rm -f /tmp/discord-emoji-audit-deploy.helper"
```

Debianでsudoersを一度だけ設定する。`visudo`の検査に通った場合だけ有効化する。

```bash
printf '%s\n' 'emojiadmin ALL=(root) NOPASSWD: /usr/local/sbin/discord-emoji-audit-deploy' | sudo tee /etc/sudoers.d/discord-emoji-audit-deploy >/dev/null
sudo chown root:root /etc/sudoers.d/discord-emoji-audit-deploy
sudo chmod 0440 /etc/sudoers.d/discord-emoji-audit-deploy
sudo visudo -cf /etc/sudoers.d/discord-emoji-audit-deploy
```

sudoersで許可するrootコマンドは固定ヘルパーだけで、npm・node・テストは`emoji-audit`ユーザーで実行される。

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
WorkingDirectory=/opt/discord-emoji-audit/current
EnvironmentFile=/etc/discord-emoji-audit.env
ExecStart=/usr/bin/node /opt/discord-emoji-audit/current/src/index.js
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
```

`current`リリースはまだないため、この時点でサービスを開始しない。Windows側から初回デプロイを実行してから有効化する。

`discord-printer-bot`や動画処理と同じProxmoxホストに置く場合も、専用LXC・専用ユーザー・専用systemdサービスで分離する。

## 自動デプロイと切り戻し

Windowsで、登録済みのSSHホスト鍵を使える状態にして実行する。PowerShellスクリプトは未コミット変更・構文・テストを確認し、現在のコミットだけをtarで転送する。Debianは`releases/<commit>`へ展開・再検査してから`current`リンクを切り替える。`DATA_DIR`と`/etc/discord-emoji-audit.env`には触れない。ヘルパー本体は転送せず、固定配置済みの`/usr/local/sbin/discord-emoji-audit-deploy`を`sudo -n`で呼び出す。

```powershell
.\tools\deploy-debian.ps1 -RemoteHost 192.168.68.101 -SshUser emojiadmin
```

初回成功後だけ、Debianで有効化する。

```bash
sudo systemctl enable discord-emoji-audit
sudo systemctl status discord-emoji-audit --no-pager
```

新リリースの`systemctl restart`または3秒後のactive確認が失敗した場合、スクリプトは`current`を旧世代へ戻して再起動する。手動切り戻しは次で実行する。

```powershell
.\tools\deploy-debian.ps1 -RemoteHost 192.168.68.101 -SshUser emojiadmin -Rollback
```

`previous`には直前の正常リリースを保持する。世代は自動削除しないため、ディスク容量を監視する。コードの切り戻しはデータ形式を戻さない。将来データ形式を変更する場合は、後方互換性またはデータ復元手順を別途用意する。

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
- 完了通知は直近30日の上位・下位を絵文字・スタンプ別に3件ずつ短く表示する。`/report` は、概要・要確認候補・絵文字棚卸し・スタンプ棚卸し・縦持ちチャンネル別・取得状況の6シートを持つXLSXを添付する。要確認候補は参考分類であり、削除を自動判断しない
- `/scan channels:<ID/メンション>` は対象チャンネルをカンマ区切りで複数指定でき、省略時は全チャンネルを対象にする。指定チャンネルのスレッドも含める
- `/report channels:<同じ指定>` は対象範囲ごとの最新スナップショットをXLSXで出力する
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
