import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { classify, emptyDatabase, guildData, lineageCandidates, linkAssets, loadDatabase, loadScanStage, mergeDaily, recordUsage, report, saveDatabase, saveScanStage, syncAssetKind, syncAssets, usageFor } from "../src/audit.js";
import { formatProgress } from "../src/progress.js";

test("現存資産だけを集計し、reaction近似を別枠にする", () => {
  const db = emptyDatabase();
  const data = guildData(db, "g");
  syncAssets(data, [{ kind: "emoji", id: "1", name: "ok" }, { kind: "sticker", id: "2", name: "wave", url: "https://cdn.example/sticker.png" }]);
  recordUsage(data, "emoji", "1", "2025-01-01T00:00:00Z", "content", 2);
  recordUsage(data, "emoji", "1", "2025-01-01T00:00:00Z", "reaction_approx", 5);
  recordUsage(data, "sticker", "2", "2025-01-01T00:00:00Z", "sticker", 1);
  assert.equal(report(data, { limit: 10 }).length, 2);
  assert.equal(report(data, { limit: 10 })[0].stats.approximateReactions, 5);
  assert.equal(data.assets["sticker:2"].url, "https://cdn.example/sticker.png");
});

test("旧IDは人間の確認後だけ系列へ加えられる", () => {
  const db = emptyDatabase();
  const data = guildData(db, "g");
  syncAssets(data, [{ kind: "emoji", id: "new", name: "new_name" }]);
  linkAssets(data, "emoji", "old", "new", "admin", "画像差し替えを確認");
  recordUsage(data, "emoji", "old", "2025-01-01T00:00:00Z", "content", 3);
  const row = report(data, { limit: 10 })[0];
  assert.equal(row.stats.all, 3);
  assert.equal(row.currentOnly.all, 0);
  assert.equal(data.assets["emoji:old"].current, false);
  assert.throws(() => linkAssets(data, "emoji", "old", "new", "admin"), /再リンク/);
});

test("後継候補は名前履歴の一致だけを未確認で提示する", () => {
  const db = emptyDatabase();
  const data = guildData(db, "g");
  syncAssets(data, [{ kind: "emoji", id: "old", name: "same" }]);
  syncAssets(data, [{ kind: "emoji", id: "new", name: "same" }]);
  assert.deepEqual(lineageCandidates(data).map((candidate) => [candidate.oldId, candidate.currentId]), [["old", "new"]]);
});

test("分類基準は数値で再現できる", () => {
  assert.equal(classify({ all: 0 }), "ほぼ未使用");
  assert.equal(classify({ all: 20, recent30: 12, recent90: 20, activeMonths: 1 }), "最近の流行");
  assert.equal(classify({ all: 20, recent30: 0, recent90: 0, peakMonthCount: 12, activeMonths: 1 }), "昔の流行");
  assert.equal(classify({ all: 20, recent30: 0, recent90: 0, peakMonthCount: 2, activeMonths: 1 }), "最近休眠");
  assert.equal(classify({ all: 30, recent30: 2, recent90: 12, activeMonths: 3 }), "定番");
});

test("emoji更新でstickerの現行状態を壊さない", () => {
  const data = guildData(emptyDatabase(), "g");
  syncAssets(data, [{ kind: "emoji", id: "e", name: "e" }, { kind: "sticker", id: "s", name: "s" }]);
  syncAssetKind(data, "emoji", [{ id: "e", name: "renamed" }]);
  assert.equal(data.assets["emoji:e"].current, true);
  assert.equal(data.assets["sticker:s"].current, true);
  assert.deepEqual(data.assets["emoji:e"].nameHistory.map((entry) => entry.name), ["e", "renamed"]);
});

test("managed emojiは棚卸し母集団から除外する", () => {
  const data = guildData(emptyDatabase(), "g");
  syncAssets(data, [{ kind: "emoji", id: "managed", name: "managed", managed: true }]);
  assert.equal(data.assets["emoji:managed"], undefined);
  assert.equal(report(data, { limit: 10 }).length, 0);
});

test("部分走査後のライブ差分はステージへ加算できる", () => {
  const daily = { "2025-01-01": { "emoji:e": { content: 2 } } };
  mergeDaily(daily, { "2025-01-01": { "emoji:e": { reaction_exact: 3 } }, "2025-01-02": { "emoji:e": { sticker: 1 } } });
  assert.deepEqual(daily, {
    "2025-01-01": { "emoji:e": { content: 2, reaction_exact: 3 } },
    "2025-01-02": { "emoji:e": { sticker: 1 }
    }
  });
});

test("reaction解除と編集差分不明は利用累計へ混ぜない", () => {
  const data = guildData(emptyDatabase(), "g");
  syncAssets(data, [{ kind: "emoji", id: "e", name: "e" }]);
  recordUsage(data, "emoji", "e", "2025-01-01T00:00:00Z", "reaction_exact", 3);
  recordUsage(data, "emoji", "e", "2025-01-01T00:00:00Z", "reaction_removed", 2);
  recordUsage(data, "emoji", "e", "2025-01-01T00:00:00Z", "content_uncertain", 4);
  const stats = usageFor(data, data.assets["emoji:e"]);
  assert.equal(stats.all, 3);
  assert.equal(stats.removedReactions, 2);
  assert.equal(stats.uncertainContent, 4);
});

test("JSON保存はバックアップと走査ステージを作る", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "emoji-audit-"));
  try {
    const databasePath = path.join(directory, "audit.json");
    const stagePath = path.join(directory, "scan.json");
    const db = emptyDatabase();
    saveDatabase(databasePath, db);
    saveDatabase(databasePath, { ...db, marker: "next" }, { backup: true });
    assert.equal(JSON.parse(fs.readFileSync(`${databasePath}.bak`, "utf8")).marker, undefined);
    fs.writeFileSync(databasePath, "壊れたJSON", "utf8");
    assert.equal(loadDatabase(databasePath).version, 1);
    saveScanStage(stagePath, { version: 1, working: db, progress: { status: "running" } });
    assert.equal(loadScanStage(stagePath).progress.status, "running");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("進捗表示は指定の1メッセージ形式とDiscord時刻タグを使う", () => {
  const text = formatProgress({ status: "running", phase: "history", messageTotalKnown: true, channelTotalKnown: true, channelIndex: 1, channelTotal: 4, channelCount: 4, threadCount: 0, messages: 100, startedAt: new Date(Date.now() - 60000).toISOString(), skippedChannels: [], discoveryErrors: [] });
  assert.match(text, /\*\*履歴取得中\*\*/);
  assert.match(text, /進捗率: \d+\.\d+% \[[█░]+\]/);
  assert.match(text, /終了予想時刻: <t:\d+:F>（<t:\d+:R>）/);
});

test("総数不明でも処理済み数を表示する", () => {
  const text = formatProgress({ status: "running", phase: "discover", messages: 12, processedChannels: 2, processedThreads: 3, skippedChannels: [], discoveryErrors: [] });
  assert.doesNotMatch(text, /不明|取得失敗/);
  assert.doesNotMatch(text, /走査エラー|進捗表示エラー/);
  assert.match(text, /処理済み: メッセージ 12件 \/ チャンネル 2件 \/ スレッド 3件/);
  assert.match(text, /集計件数: 本文絵文字 0件 \/ スタンプ 0件 \/ リアクション 0件/);
});
