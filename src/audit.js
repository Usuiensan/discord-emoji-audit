import fs from "node:fs";
import path from "node:path";

export const SOURCE = Object.freeze({
  CONTENT: "content",
  STICKER: "sticker",
  REACTION_EXACT: "reaction_exact",
  REACTION_APPROX: "reaction_approx"
});

export function emptyDatabase() {
  return { version: 1, guilds: {} };
}

export function loadDatabase(filePath) {
  if (!fs.existsSync(filePath)) return emptyDatabase();
  const value = JSON.parse(fs.readFileSync(filePath, "utf8"));
  if (value.version !== 1 || !value.guilds) throw new Error("未対応のデータ形式です");
  return value;
}

export function saveDatabase(filePath, db) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(db, null, 2)}\n`, "utf8");
}

export function guildData(db, guildId) {
  return (db.guilds[guildId] ??= {
    assets: {},
    daily: {},
    lineages: {},
    scan: { status: "never", startedAt: null, finishedAt: null, messages: 0, skippedChannels: [] },
    contentAvailable: true,
    lastEventAt: null
  });
}

export function assetKey(kind, id) {
  return `${kind}:${id}`;
}

export function syncAssets(data, assets, observedAt = new Date().toISOString()) {
  const currentKeys = new Set();
  for (const asset of assets) {
    const key = assetKey(asset.kind, asset.id);
    currentKeys.add(key);
    const existing = data.assets[key] ?? {
      id: asset.id,
      kind: asset.kind,
      names: [],
      firstObservedAt: observedAt,
      current: true,
      lineageId: key
    };
    if (asset.name && !existing.names.includes(asset.name)) existing.names.push(asset.name);
    existing.current = true;
    existing.lastObservedAt = observedAt;
    existing.managed = asset.managed ?? false;
    existing.animated = asset.animated ?? false;
    data.assets[key] = existing;
    data.lineages[existing.lineageId] ??= { members: [key], confirmedAt: null, confirmedBy: null };
  }
  for (const asset of Object.values(data.assets)) {
    if (asset.kind === "emoji" || asset.kind === "sticker") asset.current = currentKeys.has(assetKey(asset.kind, asset.id));
  }
}

export function ensureKnownAsset(data, kind, id, name = null) {
  const key = assetKey(kind, id);
  const existing = data.assets[key] ?? {
    id,
    kind,
    names: [],
    firstObservedAt: new Date().toISOString(),
    current: false,
    lineageId: key
  };
  if (name && !existing.names.includes(name)) existing.names.push(name);
  data.assets[key] = existing;
  data.lineages[existing.lineageId] ??= { members: [key], confirmedAt: null, confirmedBy: null };
  return existing;
}

export function dateKey(date) {
  return new Date(date).toISOString().slice(0, 10);
}

export function recordUsage(data, kind, id, date, source, count = 1, options = {}) {
  const asset = ensureKnownAsset(data, kind, id, options.name);
  const confirmedLineage = Boolean(data.lineages[asset.lineageId]?.confirmedAt);
  if (!asset.current && !confirmedLineage) return false;
  const day = (data.daily[dateKey(date)] ??= {});
  const row = (day[assetKey(kind, id)] ??= { content: 0, sticker: 0, reaction_exact: 0, reaction_approx: 0 });
  row[source] = (row[source] ?? 0) + count;
  return true;
}

export function linkAssets(data, kind, oldId, currentId, actor, note = "") {
  const oldAsset = ensureKnownAsset(data, kind, oldId);
  const currentAsset = ensureKnownAsset(data, kind, currentId);
  const oldLineage = oldAsset.lineageId;
  const currentLineage = currentAsset.lineageId;
  const lineageId = currentLineage;
  const members = new Set(data.lineages[currentLineage]?.members ?? [assetKey(kind, currentId)]);
  for (const key of data.lineages[oldLineage]?.members ?? [assetKey(kind, oldId)]) members.add(key);
  for (const key of members) {
    if (data.assets[key]) data.assets[key].lineageId = lineageId;
  }
  data.lineages[lineageId] = {
    members: [...members],
    confirmedAt: new Date().toISOString(),
    confirmedBy: actor,
    note
  };
}

export function usageFor(data, asset, { lineage = true } = {}) {
  const members = new Set(lineage ? (data.lineages[asset.lineageId]?.members ?? [assetKey(asset.kind, asset.id)]) : [assetKey(asset.kind, asset.id)]);
  const totals = { all: 0, recent30: 0, recent90: 0, recent365: 0, exactReactions: 0, approximateReactions: 0, activeMonths: new Set(), byMonth: {} };
  const now = Date.now();
  for (const [day, values] of Object.entries(data.daily)) {
    const age = (now - Date.parse(`${day}T23:59:59.999Z`)) / 86400000;
    for (const [key, row] of Object.entries(values)) {
      if (!members.has(key)) continue;
      const total = Object.values(row).reduce((sum, value) => sum + value, 0);
      totals.all += total;
      if (age <= 30) totals.recent30 += total;
      if (age <= 90) totals.recent90 += total;
      if (age <= 365) totals.recent365 += total;
      totals.exactReactions += row.reaction_exact ?? 0;
      totals.approximateReactions += row.reaction_approx ?? 0;
      if (total) totals.activeMonths.add(day.slice(0, 7));
      totals.byMonth[day.slice(0, 7)] = (totals.byMonth[day.slice(0, 7)] ?? 0) + total;
    }
  }
  const peak = Object.entries(totals.byMonth).sort((a, b) => b[1] - a[1])[0] ?? [null, 0];
  return { ...totals, activeMonths: totals.activeMonths.size, peakMonth: peak[0], peakMonthCount: peak[1] };
}

export function classify(stats) {
  if (stats.all === 0) return "ほぼ未使用";
  if (stats.recent30 >= 10 && stats.recent30 >= stats.recent90 * 0.5) return "最近の流行";
  if (stats.recent90 === 0 && stats.peakMonthCount >= 10) return "昔の流行";
  if (stats.recent90 === 0) return "最近休眠";
  if (stats.recent90 >= 10 && stats.activeMonths >= 3) return "定番";
  return "利用あり";
}

export function namingStatus(asset, pattern = "^[a-z0-9_]+$") {
  const regex = new RegExp(pattern);
  return { ok: regex.test(asset.names.at(-1) ?? ""), currentName: asset.names.at(-1) ?? "", names: asset.names };
}

export function lineageCandidates(data) {
  const current = Object.values(data.assets).filter((asset) => asset.current);
  const old = Object.values(data.assets).filter((asset) => !asset.current && asset.names.length);
  return old.flatMap((oldAsset) => current
    .filter((currentAsset) => currentAsset.kind === oldAsset.kind && oldAsset.names.some((name) => currentAsset.names.includes(name)))
    .map((currentAsset) => ({ kind: oldAsset.kind, oldId: oldAsset.id, oldNames: oldAsset.names, currentId: currentAsset.id, currentName: currentAsset.names.at(-1) })));
}

export function report(data, { days = 90, limit = 30, namePattern = "^[a-z0-9_]+$" } = {}) {
  const now = Date.now();
  const rows = Object.values(data.assets)
    .filter((asset) => asset.current)
    .map((asset) => {
      const stats = usageFor(data, asset);
      const currentOnly = usageFor(data, asset, { lineage: false });
      const recent = Object.entries(data.daily).reduce((sum, [day, values]) => {
        if ((now - Date.parse(`${day}T23:59:59.999Z`)) / 86400000 > days) return sum;
        const members = new Set([assetKey(asset.kind, asset.id)]);
        return sum + Object.entries(values).reduce((subtotal, [key, row]) => members.has(key) ? subtotal + Object.values(row).reduce((a, b) => a + b, 0) : subtotal, 0);
      }, 0);
      return { asset, stats, currentOnly, category: classify(stats), recent, naming: namingStatus(asset, namePattern) };
    })
    .sort((a, b) => b.recent - a.recent || b.stats.all - a.stats.all)
    .slice(0, limit);
  return rows;
}
