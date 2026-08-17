import fs from "node:fs";
import path from "node:path";

export const SOURCE = Object.freeze({
  CONTENT: "content",
  STICKER: "sticker",
  REACTION_EXACT: "reaction_exact",
  REACTION_APPROX: "reaction_approx",
  CONTENT_UNCERTAIN: "content_uncertain",
  REACTION_REMOVE: "reaction_removed"
});

export function emptyDatabase() {
  return { version: 1, guilds: {} };
}

export function loadDatabase(filePath) {
  if (!fs.existsSync(filePath)) return emptyDatabase();
  try {
    const value = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (value.version !== 1 || !value.guilds) throw new Error("未対応のデータ形式です");
    return value;
  } catch (error) {
    const backupPath = `${filePath}.bak`;
    if (!fs.existsSync(backupPath)) throw error;
    const backup = JSON.parse(fs.readFileSync(backupPath, "utf8"));
    if (backup.version !== 1 || !backup.guilds) throw error;
    console.warn(`audit.jsonを読めないためバックアップを読み込みました: ${backupPath}`);
    return backup;
  }
}

function atomicWrite(filePath, text) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, text, "utf8");
  try {
    fs.renameSync(temporaryPath, filePath);
  } catch (error) {
    if (!/EPERM|EEXIST|ENOTEMPTY/.test(error.code ?? "")) throw error;
    fs.copyFileSync(temporaryPath, filePath);
    fs.rmSync(temporaryPath, { force: true });
  }
}

export function saveDatabase(filePath, db, { backup = false } = {}) {
  if (backup && fs.existsSync(filePath)) fs.copyFileSync(filePath, `${filePath}.bak`);
  atomicWrite(filePath, `${JSON.stringify(db, null, 2)}\n`);
}

export function saveScanStage(filePath, stage) {
  atomicWrite(filePath, `${JSON.stringify(stage)}\n`);
}

export function loadScanStage(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const stage = JSON.parse(fs.readFileSync(filePath, "utf8"));
  if (stage.version !== 1 || !stage.working || !stage.progress) throw new Error("壊れた走査ステージです");
  return stage;
}

export function removeScanStage(filePath) {
  fs.rmSync(filePath, { force: true });
}

export function cloneData(value) {
  return structuredClone(value);
}

export function mergeDaily(target, delta) {
  for (const [day, values] of Object.entries(delta ?? {})) {
    const targetDay = (target[day] ??= {});
    for (const [key, row] of Object.entries(values)) {
      const targetRow = (targetDay[key] ??= {});
      for (const [source, count] of Object.entries(row)) targetRow[source] = (targetRow[source] ?? 0) + count;
    }
  }
}

export function guildData(db, guildId) {
  const data = db.guilds[guildId] ??= {
    assets: {},
    daily: {},
    channelDaily: {},
    scopeReports: {},
    lineages: {},
    scan: {
      status: "never", runId: null, startedAt: null, finishedAt: null, phase: "idle",
      messages: 0, pages: 0, channelIndex: 0, channelTotal: 0, channelTotalKnown: false, messageTotalKnown: false, channelCount: 0, threadCount: 0,
      contentUsages: 0, stickerUsages: 0, reactionUsages: 0,
      processedChannels: 0, processedThreads: 0, currentChannelId: null,
      currentChannelName: null, skippedChannels: [], discoveryErrors: [],
      progressChannelId: null, progressMessageId: null, requesterId: null, reportDays: 30, reportLimit: 10,
      excludeBots: false, excludedChannelIds: [], onlyMe: false,
      progressError: null, deferredEvents: 0, liveAppliedOffset: 0,
      scopeKey: "all", rootChannelIds: [], channelIds: [], channelNames: {}
    },
    contentAvailable: "unknown",
    assetsAvailable: "unknown",
    lastEventAt: null
  };
  data.channelDaily ??= {};
  data.scopeReports ??= {};
  data.scan ??= {};
  data.scan.scopeKey ??= "all";
  data.scan.rootChannelIds ??= [];
  data.scan.channelIds ??= [];
  data.scan.channelNames ??= {};
  return data;
}

export function assetKey(kind, id) {
  return `${kind}:${id}`;
}

const discordEpoch = 1420070400000;

export function snowflakeCreatedAt(id) {
  if (!/^\d+$/.test(String(id ?? ""))) return null;
  try {
    const milliseconds = Number((BigInt(id) >> 22n) + BigInt(discordEpoch));
    return Number.isSafeInteger(milliseconds) && milliseconds <= Date.now() ? new Date(milliseconds) : null;
  } catch {
    return null;
  }
}

function observeAssetName(asset, name, observedAt) {
  if (!name) return;
  asset.names ??= [];
  asset.nameHistory ??= [];
  if (!asset.names.includes(name)) asset.names.push(name);
  if (!asset.nameHistory.some((entry) => entry.name === name)) asset.nameHistory.push({ name, observedAt });
}

export function syncAssets(data, assets, observedAt = new Date().toISOString()) {
  const currentKeys = new Set();
  for (const asset of assets) {
    if (asset.kind === "emoji" && asset.managed) continue;
    const key = assetKey(asset.kind, asset.id);
    currentKeys.add(key);
    const existing = data.assets[key] ?? {
      id: asset.id,
      kind: asset.kind,
      names: [],
      nameHistory: [],
      firstObservedAt: observedAt,
      current: true,
      lineageId: key
    };
    observeAssetName(existing, asset.name, observedAt);
    existing.current = true;
    existing.lastObservedAt = observedAt;
    existing.managed = asset.managed ?? false;
    existing.animated = asset.animated ?? false;
    existing.url = asset.url ?? existing.url ?? null;
    data.assets[key] = existing;
    data.lineages[existing.lineageId] ??= { members: [key], confirmedAt: null, confirmedBy: null };
  }
  for (const asset of Object.values(data.assets)) {
    if (asset.kind === "emoji" || asset.kind === "sticker") asset.current = currentKeys.has(assetKey(asset.kind, asset.id));
  }
}

export function syncAssetKind(data, kind, assets, observedAt = new Date().toISOString()) {
  const currentKeys = new Set();
  for (const asset of assets) {
    if (kind === "emoji" && asset.managed) continue;
    const key = assetKey(kind, asset.id);
    currentKeys.add(key);
    const existing = data.assets[key] ?? {
      id: asset.id,
      kind,
      names: [],
      nameHistory: [],
      firstObservedAt: observedAt,
      current: true,
      lineageId: key
    };
    observeAssetName(existing, asset.name, observedAt);
    existing.current = true;
    existing.lastObservedAt = observedAt;
    existing.managed = asset.managed ?? false;
    existing.animated = asset.animated ?? false;
    existing.url = asset.url ?? existing.url ?? null;
    data.assets[key] = existing;
    data.lineages[existing.lineageId] ??= { members: [key], confirmedAt: null, confirmedBy: null };
  }
  for (const asset of Object.values(data.assets)) {
    if (asset.kind === kind) asset.current = currentKeys.has(assetKey(kind, asset.id));
  }
}

export function ensureKnownAsset(data, kind, id, name = null) {
  const key = assetKey(kind, id);
  const existing = data.assets[key] ?? {
    id,
    kind,
    names: [],
    nameHistory: [],
    firstObservedAt: new Date().toISOString(),
    current: false,
    lineageId: key
  };
  observeAssetName(existing, name, existing.lastObservedAt ?? existing.firstObservedAt);
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
  if (asset.managed || (!asset.current && !confirmedLineage)) return false;
  const day = (data.daily[dateKey(date)] ??= {});
  const row = (day[assetKey(kind, id)] ??= { content: 0, sticker: 0, reaction_exact: 0, reaction_approx: 0, content_uncertain: 0, reaction_removed: 0 });
  row[source] = (row[source] ?? 0) + count;
  return true;
}

export function linkAssets(data, kind, oldId, currentId, actor, note = "") {
  const oldAsset = ensureKnownAsset(data, kind, oldId);
  const currentAsset = ensureKnownAsset(data, kind, currentId);
  const oldLineage = oldAsset.lineageId;
  const currentLineage = currentAsset.lineageId;
  if (data.lineages[oldLineage]?.confirmedAt) throw new Error("old_id は既に確認済みの系列に属しています。再リンクはできません");
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
  if (oldLineage !== lineageId) delete data.lineages[oldLineage];
}

export function usageFor(data, asset, { lineage = true, now = Date.now() } = {}) {
  const members = new Set(lineage ? (data.lineages[asset.lineageId]?.members ?? [assetKey(asset.kind, asset.id)]) : [assetKey(asset.kind, asset.id)]);
  const totals = { all: 0, recent30: 0, recent90: 0, recent365: 0, exactReactions: 0, approximateReactions: 0, uncertainContent: 0, removedReactions: 0, activeMonths: new Set(), activeDays: new Set(), byMonth: {}, lastUse: null };
  for (const [day, values] of Object.entries(data.daily)) {
    const age = (now - Date.parse(`${day}T23:59:59.999Z`)) / 86400000;
    for (const [key, row] of Object.entries(values)) {
      if (!members.has(key)) continue;
      const total = (row.content ?? 0) + (row.sticker ?? 0) + (row.reaction_exact ?? 0) + (row.reaction_approx ?? 0);
      totals.all += total;
      if (age <= 30) totals.recent30 += total;
      if (age <= 90) totals.recent90 += total;
      if (age <= 365) totals.recent365 += total;
      totals.exactReactions += row.reaction_exact ?? 0;
      totals.approximateReactions += row.reaction_approx ?? 0;
      totals.uncertainContent += row.content_uncertain ?? 0;
      totals.removedReactions += row.reaction_removed ?? 0;
      if (total) {
        totals.activeMonths.add(day.slice(0, 7));
        totals.activeDays.add(day);
      }
      if (total && (!totals.lastUse || day > totals.lastUse)) totals.lastUse = day;
      totals.byMonth[day.slice(0, 7)] = (totals.byMonth[day.slice(0, 7)] ?? 0) + total;
    }
  }
  const peak = Object.entries(totals.byMonth).sort((a, b) => b[1] - a[1])[0] ?? [null, 0];
  const createdAt = [...members]
    .map((key) => snowflakeCreatedAt(data.assets[key]?.id))
    .filter(Boolean)
    .sort((a, b) => a - b)[0] ?? null;
  const ageDays = createdAt ? Math.max(1, Math.ceil((now - createdAt) / 86400000)) : null;
  return {
    ...totals,
    activeMonths: totals.activeMonths.size,
    activeDays: totals.activeDays.size,
    peakMonth: peak[0],
    peakMonthCount: peak[1],
    createdAt: createdAt?.toISOString() ?? null,
    ageDays,
    frequency: ageDays === null ? null : totals.all / ageDays
  };
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
  const old = Object.values(data.assets).filter((asset) => !asset.current && asset.names.length && !data.lineages[asset.lineageId]?.confirmedAt);
  return old.flatMap((oldAsset) => current
    .filter((currentAsset) => currentAsset.kind === oldAsset.kind && oldAsset.names.some((name) => currentAsset.names.includes(name)))
    .map((currentAsset) => ({ kind: oldAsset.kind, oldId: oldAsset.id, oldNames: oldAsset.names, currentId: currentAsset.id, currentName: currentAsset.names.at(-1) })));
}

export function report(data, { days = 90, limit = 30, namePattern = "^[a-z0-9_]+$" } = {}) {
  const now = Date.now();
  const rows = Object.values(data.assets)
    .filter((asset) => asset.current && !asset.managed)
    .map((asset) => {
      const stats = usageFor(data, asset, { now });
      const currentOnly = usageFor(data, asset, { lineage: false, now });
      const recent = Object.entries(data.daily).reduce((sum, [day, values]) => {
        if ((now - Date.parse(`${day}T23:59:59.999Z`)) / 86400000 > days) return sum;
        const members = new Set([assetKey(asset.kind, asset.id)]);
        return sum + Object.entries(values).reduce((subtotal, [key, row]) => members.has(key) ? subtotal + (row.content ?? 0) + (row.sticker ?? 0) + (row.reaction_exact ?? 0) + (row.reaction_approx ?? 0) : subtotal, 0);
      }, 0);
      return { asset, stats, currentOnly, category: classify(stats), recent, naming: namingStatus(asset, namePattern) };
    })
    .sort((a, b) => b.recent - a.recent || b.stats.all - a.stats.all);
  return limit === null ? rows : rows.slice(0, limit);
}
