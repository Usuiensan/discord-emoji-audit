function takeWithBoundaryTies(rows, limit, metric) {
  if (limit < 1 || rows.length <= limit) return rows.slice(0, limit);
  const boundary = metric(rows[limit - 1]);
  return rows.filter((row, index) => index < limit || metric(row) === boundary);
}

export function excludeRankRows(rows, shown) {
  const keys = new Set(shown.map((row) => row.asset ? `${row.asset.kind}:${row.asset.id}` : row.id));
  return rows.filter((row) => !keys.has(row.asset ? `${row.asset.kind}:${row.asset.id}` : row.id));
}

export function usageRankRows(rows, limit = 10) {
  const recent = [...rows].sort((a, b) => b.recent - a.recent || b.stats.all - a.stats.all);
  const recentWorst = [...rows].sort((a, b) => a.recent - b.recent || a.stats.all - b.stats.all);
  const allTop = [...rows].sort((a, b) => b.stats.all - a.stats.all || b.recent - a.recent);
  const allWorst = [...rows].sort((a, b) => a.stats.all - b.stats.all || a.recent - b.recent);
  const frequency = rows.filter((row) => Number.isFinite(row.stats.frequency));
  const frequencyTop = [...frequency].sort((a, b) => b.stats.frequency - a.stats.frequency || b.stats.all - a.stats.all);
  const frequencyWorst = [...frequency].sort((a, b) => a.stats.frequency - b.stats.frequency || a.stats.all - b.stats.all);
  return {
    recentTop: takeWithBoundaryTies(recent, limit, (row) => row.recent),
    recentWorst: takeWithBoundaryTies(recentWorst, limit, (row) => row.recent),
    allTop: takeWithBoundaryTies(allTop, limit, (row) => row.stats.all),
    allWorst: takeWithBoundaryTies(allWorst, limit, (row) => row.stats.all),
    frequencyTop: takeWithBoundaryTies(frequencyTop, limit, (row) => row.stats.frequency),
    frequencyWorst: takeWithBoundaryTies(frequencyWorst, limit, (row) => row.stats.frequency)
  };
}

export function usageRankRowsByKind(rows, limit = 10) {
  return ["emoji", "sticker"].flatMap((kind) => {
    const kindRows = rows.filter((row) => row.asset?.kind === kind);
    return kindRows.length ? [{ kind, ...usageRankRows(kindRows, limit) }] : [];
  });
}
