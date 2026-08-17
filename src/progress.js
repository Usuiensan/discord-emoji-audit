export function formatCount(value) {
  return Number(value ?? 0).toLocaleString("ja-JP");
}

export function progressPercent(scan) {
  const finished = ["complete", "complete_with_deferred"].includes(scan.status);
  if (scan.messageTotalKnown !== true) return finished ? 100 : null;
  if (scan.channelTotalKnown === false) return finished ? 100 : null;
  if (!scan.channelTotal) return ["complete", "complete_with_deferred", "partial_accepted"].includes(scan.status) ? 100 : null;
  return Math.min(100, (scan.channelIndex / scan.channelTotal) * 100);
}

export function progressBar(percent, width = 15) {
  if (percent === null) return "";
  const filled = Math.min(width, Math.floor((percent / 100) * width));
  return `進捗率: ${percent.toFixed(1)}% [${"█".repeat(filled)}${"░".repeat(width - filled)}]`;
}

export function progressEta(scan, now = Date.now()) {
  if (scan.messageTotalKnown !== true) return "";
  if (!scan.startedAt || scan.channelIndex < 1 || scan.channelIndex >= scan.channelTotal) return "";
  const elapsed = now - Date.parse(scan.startedAt);
  if (!Number.isFinite(elapsed) || elapsed <= 0) return "";
  const remaining = (scan.channelTotal - scan.channelIndex) * (elapsed / scan.channelIndex);
  const unix = Math.floor((now + remaining) / 1000);
  return `<t:${unix}:F>（<t:${unix}:R>）`;
}

export function formatCompletion(scan) {
  const scope = Number.isInteger(scan.scanDays) ? `過去${scan.scanDays}日の` : "";
  return [
    `${scope}処理済み: メッセージ ${formatCount(scan.messages)}件 / チャンネル ${formatCount(scan.processedChannels)}件 / スレッド ${formatCount(scan.processedThreads)}件`,
    `${scope}集計件数: 絵文字: 本文 ${formatCount(scan.contentUsages)}件 / リアクション ${formatCount(scan.reactionUsages)}件`,
    `${scope}集計件数: スタンプ: ${formatCount(scan.stickerUsages)}件`
  ].join("\n");
}

export function splitDiscordMessages(text, maxLength = 1900) {
  const characters = Array.from(String(text));
  const messages = [];
  while (characters.length > maxLength) {
    let cut = characters.lastIndexOf("\n", maxLength - 1) + 1;
    if (cut <= 0) cut = maxLength;
    messages.push(characters.splice(0, cut).join(""));
  }
  if (characters.length) messages.push(characters.join(""));
  return messages.length ? messages : [""];
}

export function formatProgress(scan, now = Date.now()) {
  const state = scan.status === "complete" ? "完了"
    : scan.status === "complete_with_deferred" ? "完了"
      : scan.status === "partial_accepted" ? "完了"
      : scan.status === "partial" ? "部分完了・未反映"
        : scan.status === "failed" ? "失敗・未反映"
          : scan.phase === "history" ? "履歴取得中"
            : scan.phase === "discover" ? "対象チャンネル収集中"
              : scan.phase === "commit" ? "集計反映中" : "準備中";
  const current = scan.currentChannelName ? `（${scan.currentChannelName}）` : "";
  return [
    `**${state}${current}**`,
    progressEta(scan, now) ? `終了予想時刻: ${progressEta(scan, now)}` : "",
    formatCompletion(scan),
  ].filter(Boolean).join("\n");
}
