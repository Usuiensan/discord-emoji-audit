export function usageRankRows(rows, limit = 10) {
  const recent = [...rows].sort((a, b) => b.recent - a.recent || b.stats.all - a.stats.all);
  return {
    recentTop: recent.slice(0, limit),
    recentWorst: [...rows].sort((a, b) => a.recent - b.recent || a.stats.all - b.stats.all).slice(0, limit),
    allTop: [...rows].sort((a, b) => b.stats.all - a.stats.all || b.recent - a.recent).slice(0, limit),
    allWorst: [...rows].sort((a, b) => a.stats.all - b.stats.all || a.recent - b.recent).slice(0, limit)
  };
}
