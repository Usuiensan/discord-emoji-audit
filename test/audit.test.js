import test from "node:test";
import assert from "node:assert/strict";
import { classify, emptyDatabase, guildData, lineageCandidates, linkAssets, recordUsage, report, syncAssets } from "../src/audit.js";

test("現存資産だけを集計し、reaction近似を別枠にする", () => {
  const db = emptyDatabase();
  const data = guildData(db, "g");
  syncAssets(data, [{ kind: "emoji", id: "1", name: "ok" }, { kind: "sticker", id: "2", name: "wave" }]);
  recordUsage(data, "emoji", "1", "2025-01-01T00:00:00Z", "content", 2);
  recordUsage(data, "emoji", "1", "2025-01-01T00:00:00Z", "reaction_approx", 5);
  recordUsage(data, "sticker", "2", "2025-01-01T00:00:00Z", "sticker", 1);
  assert.equal(report(data, { limit: 10 }).length, 2);
  assert.equal(report(data, { limit: 10 })[0].stats.approximateReactions, 5);
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
