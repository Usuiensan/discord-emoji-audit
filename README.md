# Discord 絵文字・スタンプ棚卸し Bot

現在サーバーに登録されているカスタム絵文字・スタンプを母集団にして、本文、スタンプ送信、リアクションを日別集計する最小構成の Bot です。

## できること

- `/audit scan`: 現在の絵文字・スタンプを確定してから、Bot が読めるチャンネルと取得できるスレッドの履歴を走査
- `/audit report`: 直近日数、累計、ピーク月、分類、命名規則を表示
- `/audit candidates`: 名前履歴が一致する旧ID→現IDの後継候補を未確認で表示
- `/audit status`: 走査状態、現在資産数、最終イベントを表示
- `/audit link`: 管理者が確認した旧IDと現在IDを同一系列として登録
- 導入後の新規本文、編集で増えた本文利用、reaction追加、改名・削除・追加イベントを追跡

本文・会話内容・ユーザーID・メッセージIDは永続保存しません。保存するのは、資産メタデータ、名前履歴、確認済み系列、日別の件数だけです。

## Discord 側の設定

Developer Portal の Bot 設定で `MESSAGE CONTENT INTENT` を有効にしてください。使用する Gateway Intent は `Guilds`、`GuildMessages`、`GuildMessageReactions`、`MessageContent` です。

Bot の招待は `bot` と `applications.commands` scope、権限は最低限 `View Channel`、`Read Message History`、`Send Messages`、`Embed Links` です。サーバー管理者が `/audit` を使うため、Bot 自身に Administrator や絵文字管理権限は不要です。チャンネルごとの権限上書きで読めない場所は走査結果に残ります。

招待URLは、Developer Portal の Application ID を使って次で作れます（権限値 `84992` は上記4権限の合計です）。

```powershell
$clientId = "アプリケーションID"
"https://discord.com/oauth2/authorize?client_id=$clientId&permissions=84992&scope=bot%20applications.commands"
```

## 起動

```powershell
Copy-Item .env.example .env
# .env に DISCORD_TOKEN を設定。DISCORD_CLIENT_ID は記録用に任意。
npm install
npm test
npm start
```

`DATA_DIR` の既定値は `./data` です。`data/audit.json` はプライベートな集計データなので Git に入れません。

## 重要な限界

- 初回走査で残っている reaction 数は、実際の reaction 日時ではなく投稿日時に帰属する**近似**です。導入後の追加はイベント観測です。解除は過去の使用回数を減らしません。
- 削除済みメッセージ、編集前の内容、解除済み reaction、画像変更でIDが変わった旧資産の対応は復元できません。
- 画像変更や同時改名を自動推測しません。管理者が `old_id` と `current_id` を確認して `/audit link` を実行し、必要なら `/audit scan` を再実行します。
- `/audit candidates` は名前履歴の完全一致だけを候補として出します。候補表示は同一性の証明ではなく、自動リンクもしません。
- 現在登録中でない資産はレポートに出ません。手動リンク後に取り込んだ旧IDの件数だけ、確認済み系列の現在資産へ合算されます。
- `MESSAGE_CONTENT` が許可されない場合、本文利用は収集できません。スタンプ・reactionだけの集計に落ちるため、状態と導入条件を明示して運用してください。
- Discord APIから取得できなかったチャンネル、権限不足のチャンネル、取得できないスレッドは「全履歴」とは扱いません。`/audit status` と `data/audit.json` の `skippedChannels` を確認してください。

分類はブラックボックスではありません。現在のコードでは、直近30日10件以上かつ直近90日の半分以上を「最近の流行」、直近90日0件かつピーク月10件以上を「昔の流行」、直近90日0件を「最近休眠」、直近90日10件以上かつ活動月3か月以上を「定番」としています。閾値は実サーバーの規模を見て変更してください。
