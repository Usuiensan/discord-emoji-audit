function takeWithBoundaryTies(rows, limit, metric) {
  if (limit < 1 || rows.length <= limit) return rows.slice(0, limit);
  const boundary = metric(rows[limit - 1]);
  return rows.filter((row, index) => index < limit || metric(row) === boundary);
}

export function usageRankRows(rows, limit = 10) {
  const recent = [...rows].sort((a, b) => b.recent - a.recent || b.stats.all - a.stats.all);
  const recentWorst = [...rows].sort((a, b) => a.recent - b.recent || a.stats.all - b.stats.all);
  const allTop = [...rows].sort((a, b) => b.stats.all - a.stats.all || b.recent - a.recent);
  const allWorst = [...rows].sort((a, b) => a.stats.all - b.stats.all || a.recent - b.recent);
  return {
    recentTop: takeWithBoundaryTies(recent, limit, (row) => row.recent),
    recentWorst: takeWithBoundaryTies(recentWorst, limit, (row) => row.recent),
    allTop: takeWithBoundaryTies(allTop, limit, (row) => row.stats.all),
    allWorst: takeWithBoundaryTies(allWorst, limit, (row) => row.stats.all)
  };
}

export function fullUsageRankRows(rows, kind) {
  return rows
    .filter((row) => row.asset.kind === kind)
    .sort((a, b) => a.recent - b.recent || a.stats.all - b.stats.all || String(a.asset.id).localeCompare(String(b.asset.id)));
}
