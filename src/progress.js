export function progressPercent(scan) {
  if (!scan.channelTotal) return ["complete", "complete_with_deferred"].includes(scan.status) ? 100 : 0;
  return Math.min(100, (scan.channelIndex / scan.channelTotal) * 100);
}

export function progressBar(percent, width = 15) {
  const filled = Math.min(width, Math.floor((percent / 100) * width));
  return `[${"█".repeat(filled)}${"░".repeat(width - filled)}] ${percent.toFixed(1)}%`;
}

export function progressEta(scan, now = Date.now()) {
  if (!scan.startedAt || scan.channelIndex < 1 || scan.channelIndex >= scan.channelTotal) return "不明";
  const elapsed = now - Date.parse(scan.startedAt);
  if (!Number.isFinite(elapsed) || elapsed <= 0) return "不明";
  const remaining = (scan.channelTotal - scan.channelIndex) * (elapsed / scan.channelIndex);
  const unix = Math.floor((now + remaining) / 1000);
  return `<t:${unix}:F>（<t:${unix}:R>）`;
}

export function formatProgress(scan, now = Date.now()) {
  const percent = progressPercent(scan);
  const state = scan.status === "complete" ? "完了"
    : scan.status === "complete_with_deferred" ? "完了・未確定イベントあり"
      : scan.status === "partial_accepted" ? "部分完了・反映済み"
      : scan.status === "partial" ? "部分完了・未反映"
        : scan.status === "failed" ? "失敗・未反映"
          : scan.phase === "history" ? "履歴取得中"
            : scan.phase === "discover" ? "対象チャンネル収集中"
              : scan.phase === "commit" ? "集計反映中" : "準備中";
  const current = scan.currentChannelName ? `（${scan.currentChannelName}）` : "";
  const rate = scan.startedAt && scan.messages
    ? `${Math.round(scan.messages / Math.max(1, (now - Date.parse(scan.startedAt)) / 60000))} messages/min`
    : "未計測";
  return [
    `進捗: ${state}${current}`,
    progressBar(percent),
    `終了予想時刻 : ${progressEta(scan, now)}`,
    `取得メッセージ: ${scan.messages ?? 0}`,
    `チャンネル: ${scan.channelIndex ?? 0} / ${scan.channelTotal ?? 0}`,
    `速度: ${rate}`,
    `失敗: ${(scan.skippedChannels?.length ?? 0) + (scan.discoveryErrors?.length ?? 0)}`,
    scan.progressError ? `進捗表示失敗: ${scan.progressError}` : "",
    scan.error ? `走査エラー: ${scan.error}` : "",
    scan.pendingLiveEvents ? `走査中イベント: ${scan.pendingLiveEvents}件（反映保留）` : "",
    scan.deferredEvents ? `走査境界で保留: ${scan.deferredEvents}件（未反映）` : ""
  ].filter(Boolean).join("\n");
}
