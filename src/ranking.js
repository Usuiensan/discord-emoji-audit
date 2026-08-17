function takeWithBoundaryTies(rows, limit, metric) {
  if (limit < 1 || rows.length <= limit) return rows.slice(0, limit);
  const boundary = metric(rows[limit - 1]);
  return rows.filter((row, index) => index < limit || metric(row) === boundary);
}

export function usageRankRows(rows, limit = 10) {
  const recent = [...rows].sort((a, b) => b.recent - a.recent || b.stats.all - a.stats.all);
  const recentWorst = [...rows].sort((a, b) => a.recent - b.recent || a.stats.all - b.stats.all);
  const allWorst = [...rows].sort((a, b) => a.stats.all - b.stats.all || a.recent - b.recent);
  return {
    recentTop: recent.slice(0, limit),
    recentWorst: takeWithBoundaryTies(recentWorst, limit, (row) => row.recent),
    allTop: [...rows].sort((a, b) => b.stats.all - a.stats.all || b.recent - a.recent).slice(0, limit),
    allWorst: takeWithBoundaryTies(allWorst, limit, (row) => row.stats.all)
  };
}
