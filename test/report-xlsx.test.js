import assert from "node:assert/strict";
import test from "node:test";
import ExcelJS from "exceljs";
import { emptyDatabase, guildData, recordUsage, syncAssets } from "../src/audit.js";
import { buildReportXlsx, reportSummaryText } from "../src/report-xlsx.js";

const pixel = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL9YQAAAABJRU5ErkJggg==", "base64");

test("画像付きの4シート棚卸しXLSXを生成する", async () => {
  const data = guildData(emptyDatabase(), "guild");
  syncAssets(data, [
    { kind: "emoji", id: "1434040043139239996", name: "hello", animated: true },
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
    scan: { finishedAt: "2026-08-17T01:23:45Z", messages: 123, skippedChannels: ["missing"], deferredEvents: 7, reportDays: 30, scanDays: null, excludeBots: false, excludedChannelIds: [] }
  };
  const output = await buildReportXlsx(data, snapshot, { fetchThumbnail: async () => ({ buffer: pixel, extension: "png" }) });
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(output);
  assert.deepEqual(workbook.worksheets.map((sheet) => sheet.name), ["概要", "絵文字", "スタンプ", "チャンネル別"]);
  assert.equal(workbook.getWorksheet("絵文字").getCell("B2").value, "hello");
  assert.equal(workbook.getWorksheet("スタンプ").getCell("B2").value, "wave");
  assert.equal(workbook.getWorksheet("チャンネル別").rowCount, 3);
  assert.equal(workbook.media.length, 2);
  assert.match(reportSummaryText(data, snapshot), /未反映イベント: 7件/);
});
