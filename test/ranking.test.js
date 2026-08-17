import test from "node:test";
import assert from "node:assert/strict";
import { fullUsageRankRows, usageRankRows } from "../src/ranking.js";

test("最近30日と累計の上位・下位を指定件数で分ける", () => {
  const rows = [
    { id: "recent-high", recent: 10, stats: { all: 1 } },
    { id: "middle", recent: 5, stats: { all: 5 } },
    { id: "all-high", recent: 1, stats: { all: 10 } },
    { id: "low", recent: 0, stats: { all: 0 } }
  ];
  const ranked = usageRankRows(rows, 2);
  assert.deepEqual(ranked.recentTop.map(({ id }) => id), ["recent-high", "middle"]);
  assert.deepEqual(ranked.recentWorst.map(({ id }) => id), ["low", "all-high"]);
  assert.deepEqual(ranked.allTop.map(({ id }) => id), ["all-high", "middle"]);
  assert.deepEqual(ranked.allWorst.map(({ id }) => id), ["low", "recent-high"]);
});

test("下位の境界件数が同じ場合は同率をすべて含める", () => {
  const rows = [
    { id: "recent-zero", recent: 0, stats: { all: 0 } },
    { id: "recent-tie-1", recent: 0, stats: { all: 3 } },
    { id: "recent-tie-2", recent: 0, stats: { all: 9 } },
    { id: "all-tie-1", recent: 1, stats: { all: 3 } },
    { id: "all-tie-2", recent: 2, stats: { all: 3 } },
    { id: "next", recent: 4, stats: { all: 8 } }
  ];

  const ranked = usageRankRows(rows, 2);

  assert.deepEqual(ranked.recentWorst.map(({ id }) => id), ["recent-zero", "recent-tie-1", "recent-tie-2"]);
  assert.deepEqual(ranked.allWorst.map(({ id }) => id), ["recent-zero", "recent-tie-1", "all-tie-1", "all-tie-2"]);
});

test("上位の境界件数が同じ場合は同率をすべて含める", () => {
  const rows = [
    { id: "recent-high", recent: 20, stats: { all: 30 } },
    { id: "recent-tie-1", recent: 10, stats: { all: 5 } },
    { id: "recent-tie-2", recent: 10, stats: { all: 15 } },
    { id: "all-high", recent: 1, stats: { all: 20 } },
    { id: "all-tie-1", recent: 2, stats: { all: 20 } },
    { id: "all-tie-2", recent: 3, stats: { all: 20 } }
  ];

  const ranked = usageRankRows(rows, 2);

  assert.deepEqual(ranked.recentTop.map(({ id }) => id), ["recent-high", "recent-tie-2", "recent-tie-1"]);
  assert.deepEqual(ranked.allTop.map(({ id }) => id), ["recent-high", "all-tie-2", "all-tie-1", "all-high"]);
});

test("全順位は絵文字とスタンプを分けて最下位から並べる", () => {
  const rows = [
    { asset: { kind: "emoji", id: "2" }, recent: 5, stats: { all: 5 } },
    { asset: { kind: "sticker", id: "3" }, recent: 0, stats: { all: 1 } },
    { asset: { kind: "emoji", id: "1" }, recent: 0, stats: { all: 2 } },
    { asset: { kind: "emoji", id: "4" }, recent: 5, stats: { all: 8 } }
  ];
  assert.deepEqual(fullUsageRankRows(rows, "emoji").map(({ asset }) => asset.id), ["1", "2", "4"]);
  assert.deepEqual(fullUsageRankRows(rows, "sticker").map(({ asset }) => asset.id), ["3"]);
});
