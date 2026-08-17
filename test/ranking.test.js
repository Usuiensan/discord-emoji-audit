import test from "node:test";
import assert from "node:assert/strict";
import { usageRankRows } from "../src/ranking.js";

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
