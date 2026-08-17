import ExcelJS from "exceljs";
import { report } from "./audit.js";

const thumbnailSize = 48;
const headerStyle = {
  font: { bold: true, color: { argb: "FFFFFFFF" } },
  fill: { type: "pattern", pattern: "solid", fgColor: { argb: "FF1F4E78" } },
  alignment: { vertical: "middle" }
};

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

function formatDate(value) {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false
  }).format(date);
}

function assetRows(data, snapshot, channelId = null) {
  const daily = channelId ? snapshot.channelDaily?.[channelId] ?? {} : snapshot.daily ?? {};
  return report({ ...data, daily }, { limit: null })
    .sort((a, b) => a.stats.recent30 - b.stats.recent30 || a.stats.all - b.stats.all || assetName(a.asset).localeCompare(assetName(b.asset), "ja"));
}

function targetLabel(snapshot) {
  return snapshot.rootChannelIds?.length ? `指定チャンネル (${snapshot.rootChannelIds.length}件)` : "サーバー全体";
}

export function reportSummary(data, snapshot) {
  const scan = snapshot.scan ?? {};
  const rows = assetRows(data, snapshot);
  return {
    target: targetLabel(snapshot),
    finishedAt: formatDate(scan.finishedAt),
    messages: scan.messages ?? 0,
    emojiCount: rows.filter((row) => row.asset.kind === "emoji").length,
    stickerCount: rows.filter((row) => row.asset.kind === "sticker").length,
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
    "**絵文字・スタンプ棚卸しレポート**",
    "",
    `対象: ${summary.target}`,
    `走査日時: ${summary.finishedAt || "不明"}`,
    `対象メッセージ: ${Number(summary.messages).toLocaleString("ja-JP")}件`,
    `絵文字: ${Number(summary.emojiCount).toLocaleString("ja-JP")}件`,
    `スタンプ: ${Number(summary.stickerCount).toLocaleString("ja-JP")}件`,
    `取得不能: ${Number(summary.unavailableChannels).toLocaleString("ja-JP")}チャンネル`,
    `未反映イベント: ${Number(summary.deferredEvents).toLocaleString("ja-JP")}件`,
    "",
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
  const thumbnails = Array(rows.length).fill(null);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(16, rows.length) }, async () => {
    while (next < rows.length) {
      const index = next++;
      thumbnails[index] = await getThumbnail(thumbnailUrl(rows[index].asset));
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
}

async function addAssetSheet(workbook, title, rows, getThumbnail) {
  const sheet = workbook.addWorksheet(title);
  sheet.addRow(["画像", "名前", "ID", "アニメーション", "直近30日", "累計", "平均使用/日", "最終使用日", "作成日時", "元画像URL"]);
  const thumbnails = await fetchThumbnails(rows, getThumbnail);
  for (const [index, row] of rows.entries()) {
    const { asset, stats } = row;
    const excelRow = sheet.addRow(["", assetName(asset), asset.id, asset.animated ? "はい" : "いいえ", stats.recent30, stats.all, stats.frequency, stats.lastUse ?? "", formatDate(stats.createdAt), sourceUrl(asset)]);
    excelRow.height = thumbnailSize;
    const thumbnail = thumbnails[index];
    if (!thumbnail) continue;
    const imageId = workbook.addImage({ buffer: thumbnail.buffer, extension: thumbnail.extension });
    sheet.addImage(imageId, { tl: { col: 0, row: excelRow.number - 1 }, ext: { width: thumbnailSize, height: thumbnailSize } });
  }
  sheet.getColumn(5).numFmt = "#,##0";
  sheet.getColumn(6).numFmt = "#,##0";
  sheet.getColumn(7).numFmt = "#,##0.00";
  styleWorksheet(sheet, [10, 28, 22, 14, 14, 14, 16, 14, 20, 62]);
}

function addSummarySheet(workbook, summary) {
  const sheet = workbook.addWorksheet("概要");
  sheet.addRow(["絵文字・スタンプ棚卸しレポート"]);
  sheet.mergeCells("A1:B1");
  sheet.getCell("A1").font = { bold: true, size: 16, color: { argb: "FFFFFFFF" } };
  sheet.getCell("A1").fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1F4E78" } };
  sheet.getCell("A1").alignment = { vertical: "middle" };
  sheet.getRow(1).height = 28;
  [
    ["対象", summary.target],
    ["走査日時", summary.finishedAt],
    ["対象メッセージ", summary.messages],
    ["絵文字", summary.emojiCount],
    ["スタンプ", summary.stickerCount],
    ["取得不能チャンネル", summary.unavailableChannels],
    ["未反映イベント", summary.deferredEvents],
    ["条件", summary.conditions]
  ].forEach((row) => sheet.addRow(row));
  for (let row = 2; row <= 9; row++) {
    sheet.getCell(row, 1).font = { bold: true };
    for (let column = 1; column <= 2; column++) sheet.getCell(row, column).border = {
      top: { style: "thin", color: { argb: "FFD9E2F3" } }, bottom: { style: "thin", color: { argb: "FFD9E2F3" } }
    };
  }
  sheet.getColumn(1).width = 22;
  sheet.getColumn(2).width = 82;
  sheet.getColumn(2).alignment = { wrapText: true, vertical: "top" };
  for (let row = 4; row <= 8; row++) sheet.getCell(row, 2).numFmt = "#,##0";
  sheet.views = [{ showGridLines: false }];
}

function addChannelSheet(workbook, data, snapshot) {
  const sheet = workbook.addWorksheet("チャンネル別");
  sheet.addRow(["チャンネルID", "チャンネル名", "種類", "名前", "ID", "直近30日", "累計", "最終使用日"]);
  const channelIds = snapshot.channelIds?.length ? snapshot.channelIds : Object.keys(snapshot.channelDaily ?? {});
  for (const channelId of channelIds) {
    for (const row of assetRows(data, snapshot, channelId).filter((item) => item.stats.all > 0)) {
      sheet.addRow([channelId, snapshot.channelNames?.[channelId] ?? "取得不能チャンネル", row.asset.kind === "emoji" ? "絵文字" : "スタンプ", assetName(row.asset), row.asset.id, row.stats.recent30, row.stats.all, row.stats.lastUse ?? ""]);
    }
  }
  sheet.getColumn(6).numFmt = "#,##0";
  sheet.getColumn(7).numFmt = "#,##0";
  styleWorksheet(sheet, [22, 30, 12, 28, 22, 14, 14, 14]);
}

export async function buildReportXlsx(data, snapshot, { fetchThumbnail: getThumbnail = fetchThumbnail } = {}) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Discord Emoji Audit Bot";
  workbook.created = new Date();
  const summary = reportSummary(data, snapshot);
  addSummarySheet(workbook, summary);
  const rows = assetRows(data, snapshot);
  await addAssetSheet(workbook, "絵文字", rows.filter((row) => row.asset.kind === "emoji"), getThumbnail);
  await addAssetSheet(workbook, "スタンプ", rows.filter((row) => row.asset.kind === "sticker"), getThumbnail);
  addChannelSheet(workbook, data, snapshot);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}
