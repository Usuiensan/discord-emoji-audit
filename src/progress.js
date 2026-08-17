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
    `処理済み: メッセージ ${scan.messages ?? 0}件 / チャンネル ${scan.processedChannels ?? 0}件 / スレッド ${scan.processedThreads ?? 0}件`,
    `集計件数: 本文絵文字 ${scan.contentUsages ?? 0}件 / スタンプ ${scan.stickerUsages ?? 0}件 / リアクション ${scan.reactionUsages ?? 0}件`,
  ].filter(Boolean).join("\n");
}
