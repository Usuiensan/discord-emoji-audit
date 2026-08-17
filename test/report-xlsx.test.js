import assert from "node:assert/strict";
import test from "node:test";
import ExcelJS from "exceljs";
import JSZip from "jszip";
import { emptyDatabase, guildData, recordUsage, syncAssetKind, syncAssets } from "../src/audit.js";
import { buildReportXlsx, reportSummary, reportSummaryText } from "../src/report-xlsx.js";

const pixel = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL9YQAAAABJRU5ErkJggg==", "base64");

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
    scan: { status: "complete", finishedAt: "2026-08-17T01:23:45Z", messages: 123, skippedChannels: ["missing"], deferredEvents: 7, reportDays: 30, scanDays: null, excludeBots: false, excludedChannelIds: [] }
  };
  const output = await buildReportXlsx(data, snapshot, { fetchThumbnail: async () => ({ buffer: pixel, extension: "png" }) });
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(output);
  assert.deepEqual(workbook.worksheets.map((sheet) => sheet.name), ["概要", "要確認候補", "絵文字棚卸し", "スタンプ棚卸し", "チャンネル別", "取得状況"]);
  assert.equal(workbook.getWorksheet("絵文字棚卸し").getCell("B3").value, "hello_latest");
  assert.ok(Number.isFinite(workbook.getWorksheet("絵文字棚卸し").getCell("G3").value));
  assert.equal(workbook.getWorksheet("絵文字棚卸し").getCell("G3").numFmt, "0.00");
  assert.equal(workbook.getWorksheet("スタンプ棚卸し").getCell("B2").value, "wave");
  const channelSheet = workbook.getWorksheet("チャンネル別");
  assert.equal(channelSheet.rowCount, 3);
  assert.deepEqual([channelSheet.getCell("C2").value, channelSheet.getCell("C3").value].sort(), ["hello_latest", "wave"]);
  assert.deepEqual([channelSheet.getCell("D2").value, channelSheet.getCell("D3").value], ["channel", "channel"]);
  assert.equal(channelSheet.getImages().length, 2);
  assert.equal(workbook.getWorksheet("要確認候補").getCell("C2").value, "Bad");
  assert.equal(workbook.getWorksheet("要確認候補").getCell("J2").value, "");
  assert.match(workbook.getWorksheet("取得状況").getCell("D2").value, /complete/);
  const summarySheet = workbook.getWorksheet("概要");
  assert.match(summarySheet.getCell("C18").value, /作成30日以内/);
  assert.match(summarySheet.getCell("C24").value, /1日平均使用回数/);
  assert.match(summarySheet.getCell("C30").value, /本文/);
  assert.doesNotMatch(summarySheet.getSheetValues().flat().filter((value) => typeof value === "string").join("\n"), /資産|要確認」は削除指示/);
  const zip = await JSZip.loadAsync(output);
  assert.match(await zip.file("xl/worksheets/sheet2.xml").async("string"), /<ignoredError sqref="I2:I4" numberStoredAsText="1"\/>/);
  assert.match(await zip.file("xl/worksheets/sheet3.xml").async("string"), /<ignoredError sqref="K2:K3" numberStoredAsText="1"\/>/);
  assert.match(await zip.file("xl/worksheets/sheet4.xml").async("string"), /<ignoredError sqref="K2:K2" numberStoredAsText="1"\/>/);
  assert.match(await zip.file("xl/worksheets/sheet5.xml").async("string"), /<ignoredError sqref="D2:D3" numberStoredAsText="1"\/>/);
  assert.match(await zip.file("xl/worksheets/sheet6.xml").async("string"), /<ignoredError sqref="B2:B4" numberStoredAsText="1"\/>/);
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
  assert.match(reportSummaryText(data, snapshot), /未反映イベント: 7件/);
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
