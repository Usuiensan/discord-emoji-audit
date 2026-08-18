import assert from "node:assert/strict";
import test from "node:test";
import ExcelJS from "exceljs";
import JSZip from "jszip";
import { emptyDatabase, guildData, recordUsage, syncAssetKind, syncAssets } from "../src/audit.js";
import { buildReportXlsx, reportSummary, reportSummaryText } from "../src/report-xlsx.js";

const pixel = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL9YQAAAABJRU5ErkJggg==", "base64");

function assertIgnoredErrorsOrder(xml) {
  const ignoredErrors = xml.indexOf("<ignoredErrors>");
  assert.ok(ignoredErrors > xml.indexOf("</sheetData>"));
  for (const marker of ["<autoFilter", "<dataValidations", "<hyperlinks", "<printOptions", "<pageMargins", "<pageSetup", "<headerFooter", "<rowBreaks", "<colBreaks", "<customProperties", "<cellWatches"]) {
    const position = xml.indexOf(marker);
    if (position >= 0) assert.ok(position < ignoredErrors, `${marker} must precede ignoredErrors`);
  }
  for (const marker of ["<smartTags", "<drawing", "<picture", "<oleObjects", "<controls", "<webPublishItems", "<tableParts", "<extLst", "</worksheet>"]) {
    const position = xml.indexOf(marker);
    if (position >= 0) assert.ok(ignoredErrors < position, `ignoredErrors must precede ${marker}`);
  }
}

test("画像付きの6シート棚卸し作業票を生成する", async () => {
  const data = guildData(emptyDatabase(), "guild");
  syncAssets(data, [
    { kind: "emoji", id: "1434040043139239996", name: "hello", animated: true },
    { kind: "emoji", id: "1434040043139239998", name: "Bad" },
    { kind: "sticker", id: "1434040043139239997", name: "wave", url: "https://cdn.example/wave.png" }
  ], "2026-08-01T00:00:00Z");
  syncAssetKind(data, "emoji", [
    { id: "1434040043139239996", name: "hello_latest", animated: true },
    { id: "1434040043139239998", name: "Bad" }
  ], "2026-08-17T00:00:00Z");
  recordUsage(data, "emoji", "1434040043139239996", "2026-08-16T00:00:00Z", "content", 4, { name: "hello" });
  recordUsage(data, "sticker", "1434040043139239997", "2026-08-16T00:00:00Z", "sticker", 2);
  const snapshot = {
    daily: data.daily,
    channelDaily: { channel: data.daily },
    channelIds: ["channel"],
    channelNames: { channel: "雑談" },
    rootChannelIds: [],
    scan: {
      status: "complete", finishedAt: "2026-08-17T01:23:45Z", messages: 123, skippedChannels: ["missing"], deferredEvents: 1,
      deferredEventDetails: [{ kind: "emoji", id: "1434040043139239996", name: "hello_latest", source: "content", count: 1, date: "2026-08-17T01:20:00Z", messageCreatedAt: "2026-08-17T01:19:00Z", messageId: "message-1", channelId: "channel" }],
      reportDays: 30, scanDays: null, excludeBots: false, excludedChannelIds: []
    }
  };
  const output = await buildReportXlsx(data, snapshot, { fetchThumbnail: async () => ({ buffer: pixel, extension: "png" }) });
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(output);
  assert.deepEqual(workbook.worksheets.map((sheet) => sheet.name), ["概要", "要確認候補", "絵文字棚卸し", "スタンプ棚卸し", "チャンネル別", "取得状況"]);
  const emojiSheet = workbook.getWorksheet("絵文字棚卸し");
  assert.deepEqual(emojiSheet.getRow(1).values.slice(1), ["画像", "名前", "種別", "直近30日", "累計", "使用日数", "1日平均使用回数", "最終使用", "作成日時", "状態", "判定", "ID", "元画像URL"]);
  assert.equal(emojiSheet.getCell("B3").value, "hello_latest");
  assert.ok(Number.isFinite(emojiSheet.getCell("G3").value));
  assert.equal(emojiSheet.getCell("G3").numFmt, "0.00");
  assert.equal(emojiSheet.getCell("I3").numFmt, "yyyy-mm-dd hh:mm");
  assert.equal(workbook.getWorksheet("スタンプ棚卸し").getCell("B2").value, "wave");
  const channelSheet = workbook.getWorksheet("チャンネル別");
  assert.equal(channelSheet.rowCount, 3);
  assert.deepEqual([channelSheet.getCell("C2").value, channelSheet.getCell("C3").value].sort(), ["hello_latest", "wave"]);
  assert.deepEqual([channelSheet.getCell("D2").value, channelSheet.getCell("D3").value], ["channel", "channel"]);
  assert.equal(channelSheet.getImages().length, 2);
  assert.equal(workbook.getWorksheet("要確認候補").getCell("C2").value, "Bad");
  assert.equal(workbook.getWorksheet("要確認候補").getCell("J2").value, "");
  const availabilitySheet = workbook.getWorksheet("取得状況");
  assert.equal(availabilitySheet.state, "hidden");
  assert.match(availabilitySheet.getCell("D2").value, /complete/);
  assert.deepEqual([availabilitySheet.getCell("A4").value, availabilitySheet.getCell("B4").value, availabilitySheet.getCell("C4").value, availabilitySheet.getCell("D4").value, availabilitySheet.getCell("E4").value, availabilitySheet.getCell("G4").value, availabilitySheet.getCell("H4").value, availabilitySheet.getCell("I4").value, availabilitySheet.getCell("J4").value, availabilitySheet.getCell("K4").value], ["イベント", "1434040043139239996", "hello_latest", "未反映", "本文", "2026/08/17 10:19:00", "message-1", "channel", "絵文字", 1]);
  const summarySheet = workbook.getWorksheet("概要");
  assert.match(summarySheet.getCell("C18").value, /作成30日以内/);
  assert.match(summarySheet.getCell("C24").value, /1日平均使用回数/);
  assert.match(summarySheet.getCell("C30").value, /本文/);
  assert.doesNotMatch(summarySheet.getSheetValues().flat().filter((value) => typeof value === "string").join("\n"), /資産|要確認」は削除指示/);
  const zip = await JSZip.loadAsync(output);
  for (const [sheet, range] of [[2, "I2:I4"], [3, "L2:L3"], [4, "L2:L2"], [5, "D2:D3"], [6, "B2:B4"]]) {
    const xml = await zip.file(`xl/worksheets/sheet${sheet}.xml`).async("string");
    assert.match(xml, new RegExp(`<ignoredError sqref="${range}" numberStoredAsText="1"\\/>`));
    assertIgnoredErrorsOrder(xml);
  }
  for (const sheet of workbook.worksheets) {
    sheet.eachRow((row) => row.eachCell((cell) => {
      if (cell.value === null || cell.value === undefined) return;
      assert.equal(cell.font.name, "Noto Sans JP");
      assert.equal(cell.alignment.horizontal, "left");
      assert.equal(cell.alignment.vertical, "middle");
      assert.equal(cell.border.bottom.style, "thin");
      if (typeof cell.value === "string") assert.equal(cell.numFmt, "@");
    }));
  }
  assert.equal(workbook.media.length, 3);
  assert.match(reportSummaryText(data, snapshot), /未反映イベント: 1件/);
});

test("命名規則外だけでは確認対象にしない", async () => {
  const data = guildData(emptyDatabase(), "guild");
  syncAssets(data, [{ kind: "emoji", id: "1434040043139239996", name: "Bad" }], "2026-08-01T00:00:00Z");
  recordUsage(data, "emoji", "1434040043139239996", "2026-08-16T00:00:00Z", "content", 31);
  const snapshot = { daily: data.daily, rootChannelIds: [], scan: {} };
  const output = await buildReportXlsx(data, snapshot, { fetchThumbnail: async () => null });
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(output);
  assert.equal(workbook.getWorksheet("要確認候補").rowCount, 1);
});

test("作成30日以内の低使用資産は確認対象にしない", async () => {
  const snowflake = (milliseconds) => ((BigInt(milliseconds - 1420070400000) << 22n) + 1n).toString();
  const createdAt = Date.now() - 10 * 86400000;
  const data = guildData(emptyDatabase(), "guild");
  const id = snowflake(createdAt);
  syncAssets(data, [{ kind: "emoji", id, name: "new_emoji" }], new Date(createdAt).toISOString());
  recordUsage(data, "emoji", id, new Date().toISOString(), "content", 1);
  const output = await buildReportXlsx(data, { daily: data.daily, rootChannelIds: [], scan: {} }, { fetchThumbnail: async () => null });
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(output);
  assert.equal(workbook.getWorksheet("要確認候補").rowCount, 1);
});

test("旧形式のチャンネルメタデータでも保存済み行と名前を落とさない", async () => {
  const data = guildData(emptyDatabase(), "guild");
  syncAssets(data, [{ kind: "emoji", id: "1434040043139239996", name: "hello" }], "2026-08-01T00:00:00Z");
  recordUsage(data, "emoji", "1434040043139239996", "2026-08-16T00:00:00Z", "content", 2);
  data.scan.channelNames = { first: "雑談", second: "告知" };
  const snapshot = {
    daily: data.daily,
    channelDaily: { first: data.daily, second: data.daily },
    channelIds: ["first"],
    channelNames: {},
    rootChannelIds: [],
    scan: {}
  };
  const output = await buildReportXlsx(data, snapshot, { fetchThumbnail: async () => null });
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(output);
  const sheet = workbook.getWorksheet("チャンネル別");
  assert.equal(sheet.rowCount, 3);
  assert.deepEqual([sheet.getCell("D2").value, sheet.getCell("E2").value, sheet.getCell("D3").value, sheet.getCell("E3").value], ["first", "雑談", "second", "告知"]);
});

test("取得状況は探索失敗を取得不能チャンネルとして表示しない", async () => {
  const data = guildData(emptyDatabase(), "guild");
  const snapshot = {
    daily: {},
    rootChannelIds: [],
    scan: {
      status: "partial",
      skippedChannels: ["123:archived_public: 権限不足", "456: messages API unavailable"],
      discoveryErrors: []
    }
  };
  const output = await buildReportXlsx(data, snapshot, { fetchThumbnail: async () => null });
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(output);
  const sheet = workbook.getWorksheet("取得状況");
  assert.equal(reportSummary(data, snapshot).unavailableChannels, 1);
  assert.equal(sheet.rowCount, 4);
  assert.deepEqual([sheet.getCell("A3").value, sheet.getCell("B3").value, sheet.getCell("D3").value], ["チャンネル", "456", "取得不能"]);
  assert.deepEqual([sheet.getCell("A4").value, sheet.getCell("D4").value], ["発見", "取得エラー"]);
});

test("期間限定走査は7/30/60/90日の観測範囲だけを表示する", async () => {
  const data = guildData(emptyDatabase(), "guild");
  syncAssets(data, [{ kind: "emoji", id: "1434040043139239996", name: "old_emoji" }], "2026-01-01T00:00:00Z");
  for (const days of [7, 30, 60, 90]) {
    const snapshot = { daily: {}, rootChannelIds: [], scan: { status: "complete", scanDays: days } };
    const output = await buildReportXlsx(data, snapshot, { fetchThumbnail: async () => null });
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(output);
    const sheet = workbook.getWorksheet("絵文字棚卸し");
    assert.deepEqual(sheet.getRow(1).values.slice(1), ["画像", "名前", "種別", `過去${days}日の使用数`, `過去${days}日の使用日数`, "最終使用", "作成日時", "状態", "判定", "ID", "元画像URL"]);
    assert.equal(sheet.getCell("F2").value, null);
    assert.equal(sheet.getCell("I2").value, "判定保留");
    assert.match(workbook.getWorksheet("概要").getSheetValues().flat().filter((value) => typeof value === "string").join("\n"), new RegExp(`過去${days}日`));
  }
});

test("全期間走査は取得範囲合計と平均頻度を表示する", async () => {
  const data = guildData(emptyDatabase(), "guild");
  syncAssets(data, [{ kind: "emoji", id: "1434040043139239996", name: "full_scan" }], "2026-08-01T00:00:00Z");
  const output = await buildReportXlsx(data, { daily: {}, rootChannelIds: [], scan: { status: "complete", scanDays: null } }, { fetchThumbnail: async () => null });
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(output);
  assert.deepEqual(workbook.getWorksheet("絵文字棚卸し").getRow(1).values.slice(1), ["画像", "名前", "種別", "直近30日", "累計", "使用日数", "1日平均使用回数", "最終使用", "作成日時", "状態", "判定", "ID", "元画像URL"]);
});

test("部分走査は取得不能範囲を理由に負方向の候補判定をしない", async () => {
  const data = guildData(emptyDatabase(), "guild");
  syncAssets(data, [{ kind: "emoji", id: "1434040043139239996", name: "unknown_usage" }], "2026-01-01T00:00:00Z");
  const snapshot = { daily: {}, rootChannelIds: [], scan: { status: "partial", scanDays: null, skippedChannels: ["missing"] } };
  const output = await buildReportXlsx(data, snapshot, { fetchThumbnail: async () => null });
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(output);
  assert.equal(workbook.getWorksheet("要確認候補").rowCount, 1);
  assert.match(workbook.getWorksheet("絵文字棚卸し").getCell("I2").value, /観測範囲不完全/);
  assert.equal(workbook.getWorksheet("絵文字棚卸し").getCell("J2").value, "判定保留");
});

test("discoveryErrorsも全資産の判定を保留にする", async () => {
  const data = guildData(emptyDatabase(), "guild");
  syncAssets(data, [{ kind: "emoji", id: "1434040043139239996", name: "discovery_incomplete" }], "2026-01-01T00:00:00Z");
  const snapshot = { daily: {}, rootChannelIds: [], scan: { status: "complete", scanDays: null, discoveryErrors: ["active_threads: timeout"] } };
  const output = await buildReportXlsx(data, snapshot, { fetchThumbnail: async () => null });
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(output);
  assert.equal(workbook.getWorksheet("絵文字棚卸し").getCell("J2").value, "判定保留");
  assert.equal(workbook.getWorksheet("要確認候補").rowCount, 1);
});
