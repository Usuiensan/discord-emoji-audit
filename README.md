# Discord 絵文字・スタンプ棚卸し Bot

現在その Discord サーバーに登録されているカスタム絵文字・スタンプを母集団にして、本文、スタンプ送信、リアクションを日別集計する Bot です。履歴メッセージの本文、発言者、通常の利用者ID、履歴メッセージIDは保存しません。走査中は実行者メンション付きの中間棚卸しメッセージ1件を編集し、完了・エラー時はそのメッセージを削除して新規結果メッセージを送ります。進捗メッセージIDとチャンネルIDだけは走査状態に保存し、`/audit link` の確認者IDは監査証跡として保存します。

## 現在できること

- `/audit scan`: 現在の資産を確定して、読めるチャンネルと取得できるスレッドの履歴を走査。`days` と `limit` で中間棚卸しの表示範囲を指定
- `/audit report`: 直近30/90/365日、指定日数、累計、最終利用日、月別ピーク、分類、命名規則を表示
- `/audit status`: 走査状態、本文取得状態、失敗数、進捗を表示
- `/audit candidates`: 名前履歴が一致する旧ID→現ID候補を未確認で表示
- `/audit link`: 管理者が確認した旧IDと現在IDを同一系列として登録
- `/audit scan-accept`: 権限不足などで部分完了した走査結果を、欠損を明示したまま反映
- 導入後の新規本文、本文編集で増えた分、reaction追加・解除、資産の追加・削除・改名を追跡

`/audit scan` は、コマンド実行者をメンションした中間棚卸しメッセージを走査中に編集します。完了時またはエラー停止時は中間メッセージを削除し、実行者メンション付きの新規メッセージを送ります。表示は次の形式です。

```text
進捗: 履歴取得中（general）
[███░░░░░░░░░░░░] 25.0%
終了予想時刻 : <t:UNIX:F>（<t:UNIX:R>）
```

履歴の総メッセージ数を先に取得できないため、初期走査中の進捗率と終了予想時刻は「不明」と表示し、処理済みメッセージ数・チャンネル数・スレッド数を表示します。完了時だけ100%になります。Discord APIの待機中は表示が止まることがありますが、APIのレート制限を無視した並列取得はしません。

## 数値の意味

- 本文・スタンプ送信・導入後に観測したreaction追加は確定観測として集計
- 初回履歴のreaction数は、実際のreaction日時ではなく現在残っている投稿の投稿日に帰属する近似
- reaction解除は `解除観測` として保存するが、過去の利用累計は減らさない
- 編集前本文が取得できない編集は `編集差分不明` として保存し、確定利用累計へ混ぜない
- 削除済みメッセージ、解除済みreaction、編集前本文、ID変更した旧資産の対応は復元しない
- 走査中に発生した、履歴と重複する可能性がある既存メッセージへのイベントは未反映として表示する
- 名前履歴の日付はrename発生日時ではなく、Botがその名前を観測した日時。正確なrename・画像変更履歴は復元しない

レポートの `現在ID` は現在の Discord IDだけ、`系列込み` は `/audit link` で管理者が確認した旧IDを含みます。候補表示は同一性の証明でも自動リンクでもありません。名前や作成時刻が似ているだけでは統合しません。

現在登録中でない資産はレポートに出ません。初回走査開始後に削除された資産も、開始時の現在スナップショットを母集団にするため新規対象にはなりません。外部サーバー由来の絵文字、Unicode絵文字は対象外です。

Discordの `managed` 絵文字は現在一覧にあっても棚卸し母集団から除外します。

## Discord側の設定

Developer Portal の Bot 設定で `MESSAGE CONTENT INTENT` を有効にしてください。使用する Gateway Intent は `Guilds`、`GuildMessages`、`GuildMessageReactions`、`MessageContent` です。

Botの招待は `bot` と `applications.commands` scope、権限は最低限 `View Channel`、`Read Message History`、`Send Messages`、`Embed Links` です。Bot自身に Administrator、絵文字管理、スタンプ管理権限は不要です。棚卸しを実行する利用者には `Manage Server` 権限が必要です。

招待URLは Developer Portal の Application ID から作れます。権限値 `84992` は上記4権限の合計です。

```powershell
$clientId = "アプリケーションID"
"https://discord.com/oauth2/authorize?client_id=$clientId&permissions=84992&scope=bot%20applications.commands"
```

`MESSAGE_CONTENT` が許可されない場合、本文は収集できず、本文状態は `unknown` のままです。reaction・スタンプだけの結果を本文込みと誤認しないでください。チャンネルごとの権限上書きで読めない場所は部分完了になります。

## ローカル起動

```powershell
Copy-Item .env.example .env
# .env に DISCORD_TOKEN を設定
npm install
npm test
npm start
```

`DATA_DIR` の既定値は `./data` です。`audit.json` は原子的に置き換え、走査開始・反映時には `audit.json.bak` を作ります。走査中は `scan-<guildId>-<runId>.json` にチェックポイント、`scan-live-<guildId>.jsonl` にメッセージIDを除いた未反映イベントを保存します。プロセス再起動後に `/audit scan` を実行すると、残ったチェックポイントとイベントログから再開できます。API障害で失敗した走査も、チェックポイントが残っていれば `/audit scan` で再開します。壊れた `audit.json` は `.bak` へフォールバックしますが、壊れたチェックポイントは削除せずエラーにします。バックアップ後に原因を確認してください。

同じ `DATA_DIR` でBotプロセスを複数起動すると、ファイルロックで2つ目を停止します。systemdサービス以外から手動起動する場合も、既存サービスを止めてから行ってください。部分走査の後に新しい走査を始める場合、未反映イベントログは削除せず `.orphan` として退避します。

## Debian LXCへの配置

`discord-printer-bot` や動画焼き込み処理と同じProxmoxホストに置く場合でも、BotごとにLXCを分ける運用を推奨します。絵文字棚卸しBotはUSB・プリンタ・動画ファイルに触れないため、同じコンテナに同居させる理由がありません。最低限、次のような専用ユーザー・専用ディレクトリ・systemdサービスにします。

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

`/etc/discord-emoji-audit.env` はrootのみ読めるようにします。

```ini
DISCORD_TOKEN=Botトークン
DATA_DIR=/var/lib/discord-emoji-audit
EMOJI_NAME_PATTERN=^[a-z0-9_]+$
```

```bash
chown root:root /etc/discord-emoji-audit.env
chmod 600 /etc/discord-emoji-audit.env
```

`/etc/systemd/system/discord-emoji-audit.service`:

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

Botの更新は、停止、`git pull`、`npm ci --omit=dev`、テスト、起動の順で行います。`audit.json` と `.bak`、走査チェックポイント、`scan-live-*`、`.orphan` は更新前にLXC外へバックアップしてください。Proxmoxバックアップまたはホスト側の世代バックアップを別途設定してください。データ形式を変更する更新では、先に複製したデータで `npm test` と復元確認を行います。

## 初回導入の安全手順

1. 自分の小さいテストサーバーへ招待し、`/audit status` で本文取得状態を確認
2. `MESSAGE_CONTENT` と対象チャンネル権限を確認してから `/audit scan`
3. 中間棚卸しが1件だけ編集され、完了・エラー時に削除後の新規メッセージになること、`/audit status` の失敗数、`/audit report` の近似reaction表示を確認
4. 失敗チャンネルがある場合は無理に「完全」と扱わず、権限を直して再走査するか、欠損を了承して `/audit scan-accept`
5. 問題がなければフレンドへ上記招待URLを渡す。サーバー運営者は招待と必要チャンネル権限の確認だけでよく、Bot側の更新・障害対応は運用者が行う

同じサーバーで `/audit scan` を同時に2回実行することはできません。走査中も通常のメッセージやreactionを止めず、重複が疑われるイベントは未反映として明示します。集計反映は最後に一度だけ行い、途中失敗で既存の確定済み集計を消しません。

## 現時点の未検証範囲

自動テスト、構文チェック、依存パッケージの監査はローカルで行えますが、実サーバーでの全履歴取得、権限設定、Discord APIの実レート制限、数十万件規模の所要時間はBotトークンなしには確認できません。最初は小さい自分のサーバーで実走査し、ログと進捗を確認してからフレンドのサーバーへ導入してください。
