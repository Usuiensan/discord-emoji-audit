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
