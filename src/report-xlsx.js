import ExcelJS from "exceljs";
import JSZip from "jszip";
import { assetKey, currentAssetName, lineageCandidates, observationMeta, report } from "./audit.js";

const thumbnailSize = 64;
const reportFont = "Noto Sans JP";
const headerStyle = {
  font: { bold: true, color: { argb: "FFFFFFFF" } },
  fill: { type: "pattern", pattern: "solid", fgColor: { argb: "FF1F4E78" } },
  alignment: { vertical: "middle" }
};
const managerChoices = "維持,削除候補,名前変更,画像変更,保留";
const idColumns = new Map([
  ["チャンネル別", "D"],
  ["取得状況", "B"]
]);

function columnLetter(number) {
  let value = "";
  for (; number > 0; number = Math.floor((number - 1) / 26)) value = String.fromCharCode(65 + ((number - 1) % 26)) + value;
  return value;
}

function assetName(asset) {
  return currentAssetName(asset) || "?";
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
  const days = Number.isInteger(snapshot.scan?.scanDays) ? snapshot.scan.scanDays : 30;
  const meta = observationMeta(snapshot.scan);
  return report({ ...data, daily }, { days, limit: null, observation: meta })
    .sort((a, b) => periodCount(a, meta) - periodCount(b, meta) || a.stats.all - b.stats.all || assetName(a.asset).localeCompare(assetName(b.asset), "ja"));
}

function periodCount(row, meta) {
  return meta.limited ? row.stats.all : row.stats.recent30;
}

function reportMeta(snapshot) {
  const meta = observationMeta(snapshot.scan);
  return { ...meta, unsafe: meta.incomplete, days: meta.scanDays ?? 30, periodLabel: meta.limited ? `過去${meta.scanDays}日` : "直近30日" };
}

function countLabel(meta) {
  return meta.limited ? `${meta.periodLabel}の使用数` : "直近30日";
}

function totalLabel(meta) {
  return meta.unsafe ? "取得範囲合計" : "累計";
}

function activeDaysLabel(meta) {
  return meta.unsafe ? `${meta.periodLabel}の使用日数` : "使用日数";
}

function targetLabel(snapshot) {
  return snapshot.rootChannelIds?.length ? `指定チャンネル (${snapshot.rootChannelIds.length}件)` : "サーバー全体";
}

function isDiscoveryError(value) {
  const text = String(value);
  return text.startsWith("active_threads:") || /^[^:]+:archived_(public|private):/.test(text);
}

function skippedChannelEntries(scan) {
  return (scan.skippedChannels ?? []).filter((value) => !isDiscoveryError(value));
}

function discoveryErrorEntries(scan) {
  return [...(scan.discoveryErrors ?? []), ...(scan.skippedChannels ?? []).filter(isDiscoveryError)];
}

function candidateIds(data) {
  return new Set(lineageCandidates(data).map((candidate) => candidate.currentId));
}

function reviewFor(row, changedIds, meta, now = Date.now()) {
  const { asset, stats } = row;
  const recentlyCreated = stats.ageDays !== null && stats.ageDays <= 30;
  const reasons = [];
  if (!recentlyCreated && !meta.unsafe) {
    if (stats.all === 0) reasons.push("登録済みだが使用記録なし");
    if (stats.recent30 === 0) reasons.push("直近30日未使用");
    if (stats.all > 0 && stats.all <= 5) reasons.push("累計5回以下");
    if (stats.lastUse && daysSince(stats.lastUse, now) >= 90) reasons.push("最終使用から90日以上");
  }
  if (changedIds.has(asset.id)) reasons.push("同名の旧ID候補あり");
  const period = periodCount(row, meta);
  const status = recentlyCreated && stats.all === 0 ? "新規登録・データ不足"
    : meta.partial ? "観測範囲不完全・判定保留"
      : meta.limited && period === 0 ? "観測範囲内で使用記録なし"
        : period >= 30 ? "頻繁に使用"
          : period > 0 ? "使用あり"
            : stats.lastUse && daysSince(stats.lastUse, now) >= 90 ? "長期未使用"
              : period === 0 ? "直近30日未使用" : "低使用";
  return { status, decision: meta.unsafe ? "判定保留" : recentlyCreated ? "維持候補" : reasons.length ? "要確認" : "維持候補", reasons };
}

function reviewMap(data, rows, meta) {
  const changedIds = candidateIds(data);
  return new Map(rows.map((row) => [assetKey(row.asset.kind, row.asset.id), reviewFor(row, changedIds, meta)]));
}

export function reportSummary(data, snapshot) {
  const scan = snapshot.scan ?? {};
  const meta = reportMeta(snapshot);
  const rows = assetRows(data, snapshot);
  const reviews = reviewMap(data, rows, meta);
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
    emojiRecent: count("emoji", (row) => periodCount(row, meta) > 0),
    stickerRecent: count("sticker", (row) => periodCount(row, meta) > 0),
    emojiReview: count("emoji", (row) => reviews.get(assetKey(row.asset.kind, row.asset.id)).decision === "要確認"),
    stickerReview: count("sticker", (row) => reviews.get(assetKey(row.asset.kind, row.asset.id)).decision === "要確認"),
    unavailableChannels: skippedChannelEntries(scan).length,
    deferredEvents: scan.deferredEvents ?? 0,
    conditions: [
      Number.isInteger(scan.scanDays) ? `走査範囲: 過去${scan.scanDays}日` : "走査範囲: 全期間",
      meta.partial ? "取得範囲不完全・負方向の判定保留" : "取得範囲: 完了",
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
    cell.alignment = { ...cell.alignment, horizontal: "left", vertical: "middle" };
    if (typeof cell.value === "string") cell.numFmt = "@";
  }));
}

async function ignoreNumberStoredAsTextWarnings(workbook, buffer) {
  const zip = await JSZip.loadAsync(buffer);
  const insertIgnoredErrors = (xml, ignoredErrors) => {
    const withoutIgnoredErrors = xml.replace(/<ignoredErrors>[\s\S]*?<\/ignoredErrors>/, "");
    const followingElements = [
      "<smartTags",
      "<drawing",
      "<picture",
      "<oleObjects",
      "<controls",
      "<webPublishItems",
      "<tableParts",
      "<extLst",
      "</worksheet>"
    ];
    const position = followingElements.reduce((current, marker) => {
      const index = withoutIgnoredErrors.indexOf(marker);
      return index >= 0 && index < current ? index : current;
    }, withoutIgnoredErrors.length);
    return withoutIgnoredErrors.slice(0, position) + ignoredErrors + withoutIgnoredErrors.slice(position);
  };
  for (const [index, sheet] of workbook.worksheets.entries()) {
    const column = idColumns.get(sheet.name) ?? (["要確認候補", "絵文字棚卸し", "スタンプ棚卸し"].includes(sheet.name)
      ? columnLetter([...sheet.getRow(1).values].indexOf("ID")) : null);
    if (!column || sheet.rowCount < 2) continue;
    const path = `xl/worksheets/sheet${index + 1}.xml`;
    const entry = zip.file(path);
    if (!entry) continue;
    const xml = await entry.async("string");
    const ignoredErrors = `<ignoredErrors><ignoredError sqref="${column}2:${column}${sheet.rowCount}" numberStoredAsText="1"/></ignoredErrors>`;
    zip.file(path, insertIgnoredErrors(xml, ignoredErrors));
  }
  return Buffer.from(await zip.generateAsync({ type: "nodebuffer" }));
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

function addAssetSheet(workbook, title, rows, reviews, thumbnails, imageIds, meta) {
  const sheet = workbook.addWorksheet(title);
  const headers = ["画像", "名前", "種別", countLabel(meta)];
  if (!meta.limited) headers.push(totalLabel(meta));
  headers.push(activeDaysLabel(meta));
  if (!meta.unsafe) headers.push("1日平均使用回数");
  headers.push("最終使用", "作成日時", "状態", "判定", "ID", "元画像URL");
  sheet.addRow(headers);
  for (const row of rows) {
    const { asset, stats } = row;
    const review = reviews.get(assetKey(asset.kind, asset.id));
    const values = ["", assetName(asset), asset.kind === "emoji" ? (asset.animated ? "アニメーション" : "静止") : "スタンプ", periodCount(row, meta)];
    if (!meta.limited) values.push(stats.all);
    values.push(stats.activeDays);
    if (!meta.unsafe) values.push(stats.frequency);
    values.push(dateValue(stats.lastUse), dateValue(stats.createdAt), review.status, review.decision, asset.id, sourceUrl(asset));
    const excelRow = sheet.addRow(values);
    excelRow.height = thumbnailSize;
    const averageColumn = headers.indexOf("1日平均使用回数") + 1;
    const lastUseColumn = headers.indexOf("最終使用") + 1;
    const createdColumn = headers.indexOf("作成日時") + 1;
    const statusColumn = headers.indexOf("状態") + 1;
    const decisionColumn = headers.indexOf("判定") + 1;
    if (averageColumn) excelRow.getCell(averageColumn).numFmt = "0.00";
    excelRow.getCell(lastUseColumn).numFmt = "yyyy-mm-dd";
    excelRow.getCell(createdColumn).numFmt = "yyyy-mm-dd hh:mm";
    excelRow.getCell(statusColumn).fill = statusStyle(review.status);
    if (review.decision === "要確認") excelRow.getCell(decisionColumn).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFE599" } };
    addThumbnail(workbook, sheet, imageIds, thumbnails, asset, excelRow.number);
  }
  [countLabel(meta), ...(meta.limited ? [] : [totalLabel(meta)]), activeDaysLabel(meta)].forEach((header) => {
    sheet.getColumn(headers.indexOf(header) + 1).numFmt = "#,##0";
  });
  styleWorksheet(sheet, headers.map((header) => header === "元画像URL" ? 62 : header.includes("使用数") || header.includes("合計") ? 16 : 14));
}

function addSummarySheet(workbook, summary, generatedAt, meta) {
  const sheet = workbook.addWorksheet("概要");
  sheet.addRow(["Discord 絵文字・スタンプ棚卸しレポート"]);
  sheet.mergeCells("A1:C1");
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
    [`${meta.periodLabel}以内に使用`, summary.emojiRecent, summary.stickerRecent],
    [meta.unsafe ? `${meta.periodLabel}観測なし（判定保留）` : "30日未使用", summary.emojiCount - summary.emojiRecent, summary.stickerCount - summary.stickerRecent],
    ["要確認", summary.emojiReview, summary.stickerReview]
  ].forEach((row) => sheet.addRow(row));
  sheet.addRow([]);
  sheet.addRow(["確認対象の条件", meta.unsafe ? "同名の旧ID候補（使用状況は観測範囲内の参考値）" : "使用数が少ない / 直近30日未使用 / 累計5回以下 / 最終使用から90日以上 / 同名の旧ID候補", "作成30日以内の絵文字・スタンプは対象外"]);
  sheet.addRow([]);
  sheet.addRow(["列定義", "項目", "内容"]);
  [
    ["概要", "レポート情報", "対象・日時・走査条件"],
    ["概要", "分類表", `登録数、${meta.periodLabel}以内に使用、${meta.unsafe ? `${meta.periodLabel}観測なし（判定保留）` : "30日未使用"}、要確認の件数`],
    ["要確認候補", "基本情報", "画像・種別・絵文字・スタンプ名"],
    ["要確認候補", "使用状況", `要確認理由・${countLabel(meta)}・${totalLabel(meta)}・${meta.unsafe ? "観測範囲内平均使用回数" : "1日平均使用回数"}・最終使用`],
    ["要確認候補", "識別情報", "Discord ID・管理者判断"],
    ["絵文字・スタンプ棚卸し", "基本情報", "画像・絵文字・スタンプ名・種別"],
    ["絵文字・スタンプ棚卸し", "使用状況", `${countLabel(meta)}・${totalLabel(meta)}・使用日数・${meta.unsafe ? "観測範囲内平均使用回数" : "1日平均使用回数"}`],
    ["絵文字・スタンプ棚卸し", "日時・判定", "最終使用・作成日時・状態・判定・Discord ID・元画像URL"],
    ["チャンネル別", "絵文字・スタンプ情報", "画像・種別・名前"],
    ["チャンネル別", "使用状況", "チャンネルID・チャンネル名・本文・リアクション・スタンプ・合計・最終使用日"],
    ["取得状況", "取得結果", "区分・対象ID・対象名・状態・詳細・イベント日時・メッセージ日時・メッセージID・チャンネルID・種別・件数"]
  ].forEach((row) => sheet.addRow(row));
  [1, 12, 20].forEach((row) => {
    sheet.getRow(row).eachCell((cell) => { if (row !== 1) cell.style = headerStyle; });
  });
  sheet.getCell("A18").style = headerStyle;
  for (let row = 21; row <= 31; row++) {
    sheet.getCell(row, 1).font = { bold: true, color: { argb: "FF1F4E78" } };
    sheet.getCell(row, 1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFD9EAF7" } };
  }
  for (let row = 2; row <= 10; row++) sheet.getCell(row, 1).font = { bold: true };
  sheet.getColumn(1).width = 28;
  sheet.getColumn(2).width = 28;
  sheet.getColumn(3).width = 72;
  for (let row = 18; row <= 31; row++) {
    sheet.getRow(row).eachCell((cell) => { cell.alignment = { wrapText: true, vertical: "middle" }; });
    sheet.getRow(row).height = row === 18 ? 42 : row === 20 ? 24 : 34;
  }
  for (let row = 2; row <= 31; row++) sheet.getRow(row).eachCell((cell) => { cell.font = { ...cell.font, size: 12 }; });
  [5, 6, 7, 8, 9, 13, 14, 15, 16].forEach((row) => sheet.getRow(row).eachCell((cell) => { cell.numFmt = "#,##0"; }));
  sheet.views = [{ showGridLines: false }];
  applyHorizontalBorders(sheet);
  applyCellDefaults(sheet);
}

function addReviewSheet(workbook, rows, reviews, thumbnails, imageIds, meta) {
  const sheet = workbook.addWorksheet("要確認候補");
  const headers = ["画像", "種別", "名前", "要確認理由", countLabel(meta)];
  if (!meta.limited) headers.push(totalLabel(meta));
  if (!meta.unsafe) headers.push("1日平均使用回数");
  headers.push("最終使用", "ID", "管理者判断");
  sheet.addRow(headers);
  for (const row of rows) {
    const review = reviews.get(assetKey(row.asset.kind, row.asset.id));
    if (review.decision !== "要確認") continue;
    const values = ["", row.asset.kind === "emoji" ? "絵文字" : "スタンプ", assetName(row.asset), review.reasons.join(" / "), periodCount(row, meta)];
    if (!meta.limited) values.push(row.stats.all);
    if (!meta.unsafe) values.push(row.stats.frequency);
    values.push(dateValue(row.stats.lastUse), row.asset.id, "");
    const excelRow = sheet.addRow(values);
    excelRow.height = thumbnailSize;
    const averageColumn = headers.indexOf("1日平均使用回数") + 1;
    const lastUseColumn = headers.indexOf("最終使用") + 1;
    const decisionColumn = headers.indexOf("管理者判断") + 1;
    if (averageColumn) excelRow.getCell(averageColumn).numFmt = "0.00";
    excelRow.getCell(lastUseColumn).numFmt = "yyyy-mm-dd";
    excelRow.getCell(decisionColumn).dataValidation = { type: "list", allowBlank: true, formulae: [`"${managerChoices}"`] };
    addThumbnail(workbook, sheet, imageIds, thumbnails, row.asset, excelRow.number);
  }
  [countLabel(meta), ...(meta.limited ? [] : [totalLabel(meta)])].forEach((header) => {
    sheet.getColumn(headers.indexOf(header) + 1).numFmt = "#,##0";
  });
  styleWorksheet(sheet, headers.map((header) => header === "要確認理由" ? 42 : header === "管理者判断" ? 18 : 14));
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

function channelName(data, snapshot, channelId) {
  return snapshot.channelNames?.[channelId]
    ?? data.scan?.channelNames?.[channelId]
    ?? data.scopeReports?.all?.channelNames?.[channelId]
    ?? channelId;
}

function eventSourceLabel(source) {
  return {
    content: "本文",
    sticker: "スタンプ投稿",
    reaction_exact: "リアクション",
    reaction_approx: "リアクション（近似）",
    content_uncertain: "本文（不確実）",
    reaction_removed: "リアクション解除"
  }[source] ?? source ?? "不明";
}

function addChannelSheet(workbook, data, snapshot, thumbnails, imageIds) {
  const sheet = workbook.addWorksheet("チャンネル別");
  sheet.addRow(["画像", "種別", "名前", "チャンネルID", "チャンネル名", "本文", "リアクション", "スタンプ", "合計", "最終使用日"]);
  const channelIds = [...new Set([...(snapshot.channelIds ?? []), ...Object.keys(snapshot.channelDaily ?? {})])];
  for (const channelId of channelIds) {
    const daily = snapshot.channelDaily?.[channelId] ?? {};
    for (const row of assetRows(data, snapshot, channelId)) {
      const totals = usageSources(data, daily, row.asset);
      const all = totals.content + totals.reactions + totals.stickers;
      if (!all) continue;
      const excelRow = sheet.addRow(["", row.asset.kind === "emoji" ? "絵文字" : "スタンプ", assetName(row.asset), channelId, channelName(data, snapshot, channelId), totals.content, totals.reactions, totals.stickers, all, dateValue(totals.lastUse)]);
      excelRow.height = thumbnailSize;
      excelRow.getCell(10).numFmt = "yyyy-mm-dd";
      addThumbnail(workbook, sheet, imageIds, thumbnails, row.asset, excelRow.number);
    }
  }
  [6, 7, 8, 9].forEach((column) => { sheet.getColumn(column).numFmt = "#,##0"; });
  styleWorksheet(sheet, [12, 12, 28, 22, 30, 14, 16, 14, 14, 14]);
}

function addAvailabilitySheet(workbook, data, snapshot) {
  const sheet = workbook.addWorksheet("取得状況");
  sheet.addRow(["区分", "対象ID", "対象名", "状態", "詳細", "イベント日時", "メッセージ日時", "メッセージID", "チャンネルID", "種別", "件数"]);
  const scan = snapshot.scan ?? {};
  sheet.addRow(["全体", "-", "スキャン", scan.status ?? "不明", `絵文字・スタンプ取得: ${data.assetsAvailable ?? "不明"} / メッセージ内容取得: ${data.contentAvailable ?? "不明"}`, "", "", "", "", "", ""]);
  for (const value of skippedChannelEntries(scan)) {
    const [id, ...detail] = String(value).split(":");
    sheet.addRow(["チャンネル", id, channelName(data, snapshot, id), "取得不能", detail.join(":").trim() || String(value), "", "", "", "", "", ""]);
  }
  for (const value of discoveryErrorEntries(scan)) sheet.addRow(["発見", "-", "チャンネル探索", "取得エラー", String(value), "", "", "", "", "", ""]);
  const deferredEvents = scan.deferredEventDetails ?? [];
  if (deferredEvents.length) {
    for (const event of deferredEvents) {
      const asset = data.assets?.[assetKey(event.kind, event.id)];
      sheet.addRow([
        "イベント", event.id ?? "-", currentAssetName(asset) || event.name || (event.kind === "emoji" ? "絵文字" : event.kind === "sticker" ? "スタンプ" : "不明"), "未反映",
        `${eventSourceLabel(event.source)}${event.parentChannelId ? ` / 親チャンネルID: ${event.parentChannelId}` : ""}`,
        formatDate(event.date), formatDate(event.messageCreatedAt), event.messageId ?? "-", event.channelId ?? "-",
        event.kind === "emoji" ? "絵文字" : event.kind === "sticker" ? "スタンプ" : event.kind ?? "", event.count ?? 0
      ]);
    }
  } else if (scan.deferredEvents) {
    sheet.addRow(["イベント", "-", "走査中のイベント", "未反映", `${scan.deferredEvents}件。個別のイベント情報は保存されていません。`, "", "", "", "", "", ""]);
  }
  if (sheet.rowCount === 2) sheet.addRow(["全体", "-", "取得状況", "問題なし", "取得不能チャンネル・未反映イベントはありません。", "", "", "", "", "", ""]);
  styleWorksheet(sheet, [14, 22, 30, 16, 44, 20, 20, 24, 22, 14, 10]);
  sheet.getColumn(5).alignment = { horizontal: "left", wrapText: true, vertical: "middle" };
  for (let rowNumber = 2; rowNumber <= sheet.rowCount; rowNumber++) {
    const cell = sheet.getCell(rowNumber, 11);
    if (typeof cell.value === "number") cell.numFmt = "#,##0";
  }
  sheet.state = "hidden";
}

export async function buildReportXlsx(data, snapshot, { fetchThumbnail: getThumbnail = fetchThumbnail } = {}) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Discord Emoji Audit Bot";
  workbook.created = new Date();
  const rows = assetRows(data, snapshot);
  const meta = reportMeta(snapshot);
  const reviews = reviewMap(data, rows, meta);
  const thumbnails = await fetchThumbnails(rows, getThumbnail);
  const imageIds = new Map();
  addSummarySheet(workbook, reportSummary(data, snapshot), workbook.created, meta);
  addReviewSheet(workbook, rows, reviews, thumbnails, imageIds, meta);
  addAssetSheet(workbook, "絵文字棚卸し", rows.filter((row) => row.asset.kind === "emoji"), reviews, thumbnails, imageIds, meta);
  addAssetSheet(workbook, "スタンプ棚卸し", rows.filter((row) => row.asset.kind === "sticker"), reviews, thumbnails, imageIds, meta);
  addChannelSheet(workbook, data, snapshot, thumbnails, imageIds);
  addAvailabilitySheet(workbook, data, snapshot);
  return ignoreNumberStoredAsTextWarnings(workbook, Buffer.from(await workbook.xlsx.writeBuffer()));
}
