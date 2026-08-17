import assert from "node:assert/strict";
import test from "node:test";
import ExcelJS from "exceljs";
import { emptyDatabase, guildData, recordUsage, syncAssets } from "../src/audit.js";
import { buildReportXlsx, reportSummaryText } from "../src/report-xlsx.js";

const pixel = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL9YQAAAABJRU5ErkJggg==", "base64");

test("画像付きの6シート棚卸し作業票を生成する", async () => {
  const data = guildData(emptyDatabase(), "guild");
  syncAssets(data, [
    { kind: "emoji", id: "1434040043139239996", name: "hello", animated: true },
    { kind: "emoji", id: "1434040043139239998", name: "Bad" },
    { kind: "sticker", id: "1434040043139239997", name: "wave", url: "https://cdn.example/wave.png" }
  ], "2026-08-01T00:00:00Z");
  recordUsage(data, "emoji", "1434040043139239996", "2026-08-16T00:00:00Z", "content", 4);
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
  assert.equal(workbook.getWorksheet("絵文字棚卸し").getCell("B3").value, "hello");
  assert.ok(Number.isFinite(workbook.getWorksheet("絵文字棚卸し").getCell("G3").value));
  assert.equal(workbook.getWorksheet("絵文字棚卸し").getCell("G3").numFmt, "0.00");
  assert.equal(workbook.getWorksheet("スタンプ棚卸し").getCell("B2").value, "wave");
  assert.equal(workbook.getWorksheet("チャンネル別").rowCount, 3);
  assert.equal(workbook.getWorksheet("要確認候補").getCell("C2").value, "Bad");
  assert.equal(workbook.getWorksheet("要確認候補").getCell("J2").value, "");
  assert.match(workbook.getWorksheet("取得状況").getCell("D2").value, /complete/);
  for (const sheet of workbook.worksheets) {
    sheet.eachRow((row) => row.eachCell((cell) => {
      if (cell.value === null || cell.value === undefined) return;
      assert.equal(cell.font.name, "Noto Sans JP");
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
