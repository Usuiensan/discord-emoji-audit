import ExcelJS from "exceljs";
import { assetKey, lineageCandidates, report } from "./audit.js";

const thumbnailSize = 64;
const reportFont = "Noto Sans JP";
const headerStyle = {
  font: { bold: true, color: { argb: "FFFFFFFF" } },
  fill: { type: "pattern", pattern: "solid", fgColor: { argb: "FF1F4E78" } },
  alignment: { vertical: "middle" }
};
const managerChoices = "維持,削除候補,名前変更,画像変更,保留";

function assetName(asset) {
  return asset.names?.at(-1) ?? "?";
}

function sourceUrl(asset) {
  if (asset.kind === "emoji") return `https://cdn.discordapp.com/emojis/${asset.id}.${asset.animated ? "gif" : "png"}?size=160&quality=lossless`;
  return asset.url ?? `https://media.discordapp.net/stickers/${asset.id}.png?size=160&quality=lossless`;
}

function thumbnailUrl(asset) {
  return asset.kind === "emoji"
    ? `https://cdn.discordapp.com/emojis/${asset.id}.png?size=64&quality=lossless`
    : `https://media.discordapp.net/stickers/${asset.id}.png?size=64&quality=lossless`;
}

function dateValue(value) {
  if (!value) return null;
  const date = new Date(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00Z` : value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatDate(value) {
  const date = dateValue(value);
  return date ? new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false
  }).format(date) : "";
}

function daysSince(value, now = Date.now()) {
  const date = dateValue(value);
  return date ? Math.floor((now - date.getTime()) / 86400000) : null;
}

function assetRows(data, snapshot, channelId = null) {
  const daily = channelId ? snapshot.channelDaily?.[channelId] ?? {} : snapshot.daily ?? {};
  return report({ ...data, daily }, { limit: null })
    .sort((a, b) => a.stats.recent30 - b.stats.recent30 || a.stats.all - b.stats.all || assetName(a.asset).localeCompare(assetName(b.asset), "ja"));
}

function targetLabel(snapshot) {
  return snapshot.rootChannelIds?.length ? `指定チャンネル (${snapshot.rootChannelIds.length}件)` : "サーバー全体";
}

function candidateIds(data) {
  return new Set(lineageCandidates(data).map((candidate) => candidate.currentId));
}

function reviewFor(row, changedIds, now = Date.now()) {
  const { asset, stats } = row;
  const reasons = [];
  if (stats.all === 0) reasons.push("登録済みだが使用記録なし");
  if (stats.recent30 === 0) reasons.push("直近30日未使用");
  if (stats.all > 0 && stats.all <= 5) reasons.push("累計5回以下");
  if (stats.lastUse && daysSince(stats.lastUse, now) >= 90) reasons.push("最終使用から90日以上");
  if (changedIds.has(asset.id)) reasons.push("同名の旧ID候補あり");
  const status = stats.ageDays !== null && stats.ageDays <= 30 && stats.all === 0 ? "新規登録・データ不足"
    : stats.recent30 >= 30 ? "頻繁に使用"
      : stats.recent30 > 0 ? "使用あり"
        : stats.lastUse && daysSince(stats.lastUse, now) >= 90 ? "長期未使用"
          : stats.recent30 === 0 ? "直近30日未使用" : "低使用";
  return { status, decision: reasons.length ? "要確認" : "維持候補", reasons };
}

function reviewMap(data, rows) {
  const changedIds = candidateIds(data);
  return new Map(rows.map((row) => [assetKey(row.asset.kind, row.asset.id), reviewFor(row, changedIds)]));
}

export function reportSummary(data, snapshot) {
  const scan = snapshot.scan ?? {};
  const rows = assetRows(data, snapshot);
  const reviews = reviewMap(data, rows);
  const byKind = (kind) => rows.filter((row) => row.asset.kind === kind);
  const count = (kind, predicate) => byKind(kind).filter(predicate).length;
  return {
    target: targetLabel(snapshot),
    finishedAt: formatDate(scan.finishedAt),
    messages: scan.messages ?? 0,
    channels: scan.processedChannels ?? scan.channelCount ?? snapshot.channelIds?.length ?? 0,
    threads: scan.processedThreads ?? scan.threadCount ?? 0,
    emojiCount: count("emoji", () => true),
    stickerCount: count("sticker", () => true),
    emojiRecent: count("emoji", (row) => row.stats.recent30 > 0),
    stickerRecent: count("sticker", (row) => row.stats.recent30 > 0),
    emojiReview: count("emoji", (row) => reviews.get(assetKey(row.asset.kind, row.asset.id)).decision === "要確認"),
    stickerReview: count("sticker", (row) => reviews.get(assetKey(row.asset.kind, row.asset.id)).decision === "要確認"),
    unavailableChannels: scan.skippedChannels?.length ?? 0,
    deferredEvents: scan.deferredEvents ?? 0,
    conditions: [
      Number.isInteger(scan.scanDays) ? `走査範囲: 過去${scan.scanDays}日` : "走査範囲: 全期間",
      scan.excludeBots ? "Bot投稿を除外" : "Bot投稿を含む",
      scan.excludedChannelIds?.length ? `除外チャンネル: ${scan.excludedChannelIds.length}件` : "除外チャンネルなし"
    ].join(" / ")
  };
}

export function reportSummaryText(data, snapshot) {
  const summary = reportSummary(data, snapshot);
  return [
    "**絵文字・スタンプ棚卸しレポート**", "",
    `対象: ${summary.target}`,
    `走査日時: ${summary.finishedAt || "不明"}`,
    `対象メッセージ: ${Number(summary.messages).toLocaleString("ja-JP")}件`,
    `絵文字: ${Number(summary.emojiCount).toLocaleString("ja-JP")}件`,
    `スタンプ: ${Number(summary.stickerCount).toLocaleString("ja-JP")}件`,
    `取得不能: ${Number(summary.unavailableChannels).toLocaleString("ja-JP")}チャンネル`,
    `未反映イベント: ${Number(summary.deferredEvents).toLocaleString("ja-JP")}件`, "",
    "詳細は添付ファイルを確認してください。"
  ].join("\n");
}

async function fetchThumbnail(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(3_000) });
    const type = response.headers.get("content-type")?.split(";")[0].toLowerCase();
    if (!response.ok || !["image/png", "image/jpeg"].includes(type)) return null;
    return { buffer: Buffer.from(await response.arrayBuffer()), extension: type === "image/png" ? "png" : "jpeg" };
  } catch {
    return null;
  }
}

async function fetchThumbnails(rows, getThumbnail) {
  const thumbnails = new Map();
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(16, rows.length) }, async () => {
    while (next < rows.length) {
      const row = rows[next++];
      thumbnails.set(assetKey(row.asset.kind, row.asset.id), await getThumbnail(thumbnailUrl(row.asset)));
    }
  }));
  return thumbnails;
}

function styleWorksheet(sheet, widths) {
  sheet.views = [{ state: "frozen", ySplit: 1, showGridLines: false }];
  sheet.getRow(1).height = 24;
  sheet.getRow(1).eachCell((cell) => { cell.style = headerStyle; });
  sheet.columns.forEach((column, index) => { column.width = widths[index] ?? 16; });
  sheet.autoFilter = { from: "A1", to: { row: 1, column: sheet.columnCount } };
  applyHorizontalBorders(sheet);
  applyCellDefaults(sheet);
}

function applyHorizontalBorders(sheet) {
  for (let rowNumber = 1; rowNumber <= sheet.rowCount; rowNumber++) {
    const row = sheet.getRow(rowNumber);
    if (!row.hasValues) continue;
    for (let columnNumber = 1; columnNumber <= sheet.columnCount; columnNumber++) {
      const cell = row.getCell(columnNumber);
      cell.border = { ...cell.border, bottom: { style: "thin", color: { argb: "FFD9E2F3" } } };
    }
  }
}

function applyCellDefaults(sheet) {
  sheet.eachRow((row) => row.eachCell((cell) => {
    cell.font = { ...cell.font, name: reportFont };
    cell.alignment = { ...cell.alignment, vertical: "middle" };
    if (typeof cell.value === "string") cell.numFmt = "@";
  }));
}

function addThumbnail(workbook, sheet, imageIds, thumbnails, asset, rowNumber) {
  const key = assetKey(asset.kind, asset.id);
  const thumbnail = thumbnails.get(key);
  if (!thumbnail) return;
  const imageId = imageIds.get(key) ?? workbook.addImage({ buffer: thumbnail.buffer, extension: thumbnail.extension });
  imageIds.set(key, imageId);
  sheet.addImage(imageId, { tl: { col: 0, row: rowNumber - 1 }, ext: { width: thumbnailSize, height: thumbnailSize } });
}

function statusStyle(status) {
  if (status === "長期未使用") return { type: "pattern", pattern: "solid", fgColor: { argb: "FFF4CCCC" } };
  if (status === "直近30日未使用" || status === "低使用") return { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFF2CC" } };
  if (status === "頻繁に使用") return { type: "pattern", pattern: "solid", fgColor: { argb: "FFD9EAD3" } };
  return undefined;
}

function addAssetSheet(workbook, title, rows, reviews, thumbnails, imageIds) {
  const sheet = workbook.addWorksheet(title);
  sheet.addRow(["画像", "名前", "種別", "直近30日", "累計", "使用日数", "最終使用", "状態", "判定", "ID", "作成日時", "元画像URL"]);
  for (const row of rows) {
    const { asset, stats } = row;
    const review = reviews.get(assetKey(asset.kind, asset.id));
    const excelRow = sheet.addRow(["", assetName(asset), asset.kind === "emoji" ? (asset.animated ? "アニメーション" : "静止") : "スタンプ", stats.recent30, stats.all, stats.activeDays, dateValue(stats.lastUse), review.status, review.decision, asset.id, dateValue(stats.createdAt), sourceUrl(asset)]);
    excelRow.height = thumbnailSize;
    excelRow.getCell(7).numFmt = "yyyy-mm-dd";
    excelRow.getCell(11).numFmt = "yyyy-mm-dd hh:mm";
    excelRow.getCell(8).fill = statusStyle(review.status);
    if (review.decision === "要確認") excelRow.getCell(9).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFE599" } };
    addThumbnail(workbook, sheet, imageIds, thumbnails, asset, excelRow.number);
  }
  [4, 5, 6].forEach((column) => { sheet.getColumn(column).numFmt = "#,##0"; });
  styleWorksheet(sheet, [12, 28, 18, 14, 14, 14, 14, 20, 14, 22, 20, 62]);
}

function addSummarySheet(workbook, summary, generatedAt) {
  const sheet = workbook.addWorksheet("概要");
  sheet.addRow(["Discord 絵文字・スタンプ棚卸しレポート"]);
  sheet.mergeCells("A1:B1");
  sheet.getCell("A1").font = { bold: true, size: 16, color: { argb: "FFFFFFFF" } };
  sheet.getCell("A1").fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1F4E78" } };
  sheet.getCell("A1").alignment = { vertical: "middle" };
  sheet.getRow(1).height = 28;
  [
    ["対象", summary.target], ["出力日時", formatDate(generatedAt)], ["最終フルスキャン", summary.finishedAt],
    ["対象メッセージ", summary.messages], ["対象チャンネル", summary.channels], ["対象スレッド", summary.threads],
    ["取得不能", summary.unavailableChannels], ["未反映イベント", summary.deferredEvents], ["条件", summary.conditions]
  ].forEach((row) => sheet.addRow(row));
  sheet.addRow([]);
  sheet.addRow(["分類", "絵文字", "スタンプ"]);
  [
    ["登録数", summary.emojiCount, summary.stickerCount],
    ["30日以内に使用", summary.emojiRecent, summary.stickerRecent],
    ["30日未使用", summary.emojiCount - summary.emojiRecent, summary.stickerCount - summary.stickerRecent],
    ["要確認", summary.emojiReview, summary.stickerReview]
  ].forEach((row) => sheet.addRow(row));
  sheet.addRow([]);
  sheet.addRow(["注意事項", "「要確認」は削除指示ではありません。季節・イベント用途などを管理者が判断してください。"]);
  [1, 12, 18].forEach((row) => {
    sheet.getRow(row).eachCell((cell) => { if (row !== 1) cell.style = headerStyle; });
  });
  for (let row = 2; row <= 10; row++) sheet.getCell(row, 1).font = { bold: true };
  sheet.getColumn(1).width = 24;
  sheet.getColumn(2).width = 84;
  sheet.getColumn(3).width = 16;
  sheet.getCell("B18").alignment = { wrapText: true, vertical: "top" };
  sheet.getRow(18).height = 34;
  [5, 6, 7, 8, 9, 13, 14, 15, 16].forEach((row) => sheet.getRow(row).eachCell((cell) => { cell.numFmt = "#,##0"; }));
  sheet.views = [{ showGridLines: false }];
  applyHorizontalBorders(sheet);
  applyCellDefaults(sheet);
}

function addReviewSheet(workbook, rows, reviews, thumbnails, imageIds) {
  const sheet = workbook.addWorksheet("要確認候補");
  sheet.addRow(["画像", "種別", "名前", "要確認理由", "直近30日", "累計", "最終使用", "ID", "管理者判断"]);
  for (const row of rows) {
    const review = reviews.get(assetKey(row.asset.kind, row.asset.id));
    if (review.decision !== "要確認") continue;
    const excelRow = sheet.addRow(["", row.asset.kind === "emoji" ? "絵文字" : "スタンプ", assetName(row.asset), review.reasons.join(" / "), row.stats.recent30, row.stats.all, dateValue(row.stats.lastUse), row.asset.id, ""]);
    excelRow.height = thumbnailSize;
    excelRow.getCell(7).numFmt = "yyyy-mm-dd";
    excelRow.getCell(9).dataValidation = { type: "list", allowBlank: true, formulae: [`"${managerChoices}"`] };
    addThumbnail(workbook, sheet, imageIds, thumbnails, row.asset, excelRow.number);
  }
  [5, 6].forEach((column) => { sheet.getColumn(column).numFmt = "#,##0"; });
  styleWorksheet(sheet, [12, 12, 28, 42, 14, 14, 14, 22, 18]);
}

function usageSources(data, daily, asset) {
  const members = new Set(data.lineages[asset.lineageId]?.members ?? [assetKey(asset.kind, asset.id)]);
  const totals = { content: 0, reactions: 0, stickers: 0, lastUse: null };
  for (const [day, values] of Object.entries(daily)) {
    for (const [key, value] of Object.entries(values)) {
      if (!members.has(key)) continue;
      const content = value.content ?? 0;
      const reactions = (value.reaction_exact ?? 0) + (value.reaction_approx ?? 0);
      const stickers = value.sticker ?? 0;
      if (content + reactions + stickers > 0 && (!totals.lastUse || day > totals.lastUse)) totals.lastUse = day;
      totals.content += content;
      totals.reactions += reactions;
      totals.stickers += stickers;
    }
  }
  return totals;
}

function addChannelSheet(workbook, data, snapshot) {
  const sheet = workbook.addWorksheet("チャンネル別");
  sheet.addRow(["種別", "名前", "チャンネルID", "チャンネル名", "本文", "リアクション", "スタンプ", "合計", "最終使用日"]);
  const channelIds = snapshot.channelIds?.length ? snapshot.channelIds : Object.keys(snapshot.channelDaily ?? {});
  for (const channelId of channelIds) {
    const daily = snapshot.channelDaily?.[channelId] ?? {};
    for (const row of assetRows(data, snapshot, channelId)) {
      const totals = usageSources(data, daily, row.asset);
      const all = totals.content + totals.reactions + totals.stickers;
      if (!all) continue;
      const excelRow = sheet.addRow([row.asset.kind === "emoji" ? "絵文字" : "スタンプ", assetName(row.asset), channelId, snapshot.channelNames?.[channelId] ?? "取得不能チャンネル", totals.content, totals.reactions, totals.stickers, all, dateValue(totals.lastUse)]);
      excelRow.getCell(9).numFmt = "yyyy-mm-dd";
    }
  }
  [5, 6, 7, 8].forEach((column) => { sheet.getColumn(column).numFmt = "#,##0"; });
  styleWorksheet(sheet, [12, 28, 22, 30, 14, 16, 14, 14, 14]);
}

function addAvailabilitySheet(workbook, data, snapshot) {
  const sheet = workbook.addWorksheet("取得状況");
  sheet.addRow(["区分", "対象ID", "対象名", "状態", "詳細"]);
  const scan = snapshot.scan ?? {};
  sheet.addRow(["全体", "-", "スキャン", scan.status ?? "不明", `絵文字・スタンプ取得: ${data.assetsAvailable ?? "不明"} / メッセージ内容取得: ${data.contentAvailable ?? "不明"}`]);
  for (const value of scan.skippedChannels ?? []) {
    const [id, ...detail] = String(value).split(":");
    sheet.addRow(["チャンネル", id, snapshot.channelNames?.[id] ?? "取得不能チャンネル", "取得不能", detail.join(":").trim() || String(value)]);
  }
  for (const value of scan.discoveryErrors ?? []) sheet.addRow(["発見", "-", "チャンネル探索", "取得エラー", String(value)]);
  if (scan.deferredEvents) sheet.addRow(["イベント", "-", "走査中のイベント", "未反映", `${scan.deferredEvents}件。個別のイベント情報はスナップショットに保存されていません。`]);
  if (sheet.rowCount === 2) sheet.addRow(["全体", "-", "取得状況", "問題なし", "取得不能チャンネル・未反映イベントはありません。"]);
  styleWorksheet(sheet, [14, 22, 30, 16, 80]);
  sheet.getColumn(5).alignment = { wrapText: true, vertical: "middle" };
}

export async function buildReportXlsx(data, snapshot, { fetchThumbnail: getThumbnail = fetchThumbnail } = {}) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Discord Emoji Audit Bot";
  workbook.created = new Date();
  const rows = assetRows(data, snapshot);
  const reviews = reviewMap(data, rows);
  const thumbnails = await fetchThumbnails(rows, getThumbnail);
  const imageIds = new Map();
  addSummarySheet(workbook, reportSummary(data, snapshot), workbook.created);
  addReviewSheet(workbook, rows, reviews, thumbnails, imageIds);
  addAssetSheet(workbook, "絵文字棚卸し", rows.filter((row) => row.asset.kind === "emoji"), reviews, thumbnails, imageIds);
  addAssetSheet(workbook, "スタンプ棚卸し", rows.filter((row) => row.asset.kind === "sticker"), reviews, thumbnails, imageIds);
  addChannelSheet(workbook, data, snapshot);
  addAvailabilitySheet(workbook, data, snapshot);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}
