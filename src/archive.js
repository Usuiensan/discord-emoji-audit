import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import JSZip from "jszip";

const maxMediaBytes = 4 * 1024 * 1024;
const extensions = ["webp", "png", "gif", "json"];

function validAsset(kind, id) {
  return ["emoji", "sticker"].includes(kind) && /^\d{1,25}$/.test(String(id ?? ""));
}

function mergeEntry(target, source) {
  target.names ??= [];
  for (const name of source.names ?? (source.name ? [source.name] : [])) {
    if (typeof name === "string" && name && !target.names.includes(name)) target.names.push(name);
  }
  if (source.animated === true) target.animated = true;
  else if (target.animated === undefined && source.animated === false) target.animated = false;
  if ([1, 2, 3, 4].includes(source.formatType ?? source.format)) target.formatType = source.formatType ?? source.format;
  if (source.firstObservedAt && (!target.firstObservedAt || source.firstObservedAt < target.firstObservedAt)) target.firstObservedAt = source.firstObservedAt;
  if (source.lastObservedAt && (!target.lastObservedAt || source.lastObservedAt > target.lastObservedAt)) target.lastObservedAt = source.lastObservedAt;
  return target;
}

// Archive discovery is independent from usage totals: external/deleted IDs are intentionally
// excluded from the audit's current-asset usage statistics, but not from this catalog.
export function observeArchiveEvents(data, events) {
  data.archiveCatalog ??= {};
  const observed = [];
  for (const event of events) {
    if (!validAsset(event.kind, event.id)) continue;
    const key = `${event.kind}:${event.id}`;
    const entry = data.archiveCatalog[key] ??= { kind: event.kind, id: String(event.id), names: [] };
    mergeEntry(entry, { ...event, lastObservedAt: event.date instanceof Date ? event.date.toISOString() : event.date });
    observed.push(entry);
  }
  return observed;
}

export function syncArchiveGuildAssets(data, assets) {
  data.archiveCatalog ??= {};
  for (const entry of Object.values(data.archiveCatalog)) {
    if (entry.guildAsset) entry.guildCurrent = false;
  }
  for (const asset of assets) {
    if (!validAsset(asset.kind, asset.id)) continue;
    const key = `${asset.kind}:${asset.id}`;
    const entry = data.archiveCatalog[key] ??= { kind: asset.kind, id: String(asset.id), names: [] };
    mergeEntry(entry, asset);
    entry.guildAsset = true;
    entry.guildCurrent = true;
  }
}

export function mergeArchiveCatalog(target, source) {
  target.archiveCatalog ??= {};
  for (const entry of Object.values(source.archiveCatalog ?? {})) {
    if (!validAsset(entry.kind, entry.id)) continue;
    const key = `${entry.kind}:${entry.id}`;
    const merged = target.archiveCatalog[key] ??= { kind: entry.kind, id: entry.id, names: [] };
    mergeEntry(merged, entry);
    if (entry.guildAsset && !merged.guildAsset) {
      merged.guildAsset = true;
      merged.guildCurrent = entry.guildCurrent;
    }
  }
}

export function archiveCandidates(data, scope = "all") {
  const all = new Map();
  function add(entry, ownership = "history_only") {
    if (!entry || !validAsset(entry.kind, entry.id)) return;
    const key = `${entry.kind}:${entry.id}`;
    const candidate = all.get(key) ?? { kind: entry.kind, id: String(entry.id), names: [], ownership: "history_only" };
    mergeEntry(candidate, entry);
    if (ownership === "current" || (ownership === "former" && candidate.ownership !== "current")) candidate.ownership = ownership;
    all.set(key, candidate);
  }
  for (const asset of Object.values(data.assets ?? {})) {
    add(asset, asset.current ? "current" : "former");
  }
  for (const entry of Object.values(data.archiveCatalog ?? {})) add(entry, entry.guildAsset ? (entry.guildCurrent ? "current" : "former") : "history_only");
  for (const event of data.scan?.deferredEventDetails ?? []) add(event);
  const result = [...all.values()].filter((entry) => scope === "all" || (scope === "current" ? entry.ownership === "current" : entry.ownership !== "current"));
  const rank = { current: 0, former: 1, history_only: 2 };
  return result.sort((a, b) => rank[a.ownership] - rank[b.ownership] || a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id));
}

export function archiveUrls(asset) {
  if (!validAsset(asset.kind, asset.id)) return [];
  if (asset.kind === "emoji") {
    // Discord's emoji source is 128x128; asking for 4096 only upscales it.
    const animated = asset.animated !== false ? "?size=128&animated=true" : "?size=128";
    return [
      { url: `https://cdn.discordapp.com/emojis/${asset.id}.webp${animated}`, extension: "webp" },
      ...(asset.animated === true ? [{ url: `https://cdn.discordapp.com/emojis/${asset.id}.gif?size=128`, extension: "gif" }] : []),
      { url: `https://cdn.discordapp.com/emojis/${asset.id}.png?size=128`, extension: "png" }
    ];
  }
  const png = { url: `https://cdn.discordapp.com/stickers/${asset.id}.png`, extension: "png" };
  const gif = { url: `https://media.discordapp.net/stickers/${asset.id}.gif`, extension: "gif" };
  const json = { url: `https://cdn.discordapp.com/stickers/${asset.id}.json`, extension: "json" };
  if (asset.formatType === 3) return [json];
  if (asset.formatType === 4) return [gif];
  if (asset.formatType === 1 || asset.formatType === 2) return [png];
  return [png, gif, json];
}

function validContent(buffer, extension) {
  if (extension === "png") return buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (extension === "gif") return buffer.subarray(0, 6).toString("ascii").match(/^GIF8[79]a$/) !== null;
  if (extension === "webp") return buffer.length >= 12 && buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP";
  if (extension === "json") {
    try { const value = JSON.parse(buffer.toString("utf8")); return typeof value === "object" && value !== null && Array.isArray(value.layers); } catch { return false; }
  }
  return false;
}

function animatedWebp(buffer) {
  if (!validContent(buffer, "webp")) return false;
  for (let offset = 12; offset + 8 <= buffer.length;) {
    const chunk = buffer.toString("ascii", offset, offset + 4);
    if (chunk === "ANIM" || chunk === "ANMF") return true;
    if (chunk === "VP8X" && offset + 9 <= buffer.length && (buffer[offset + 8] & 2)) return true;
    const size = buffer.readUInt32LE(offset + 4);
    offset += 8 + size + (size % 2);
  }
  return false;
}

async function download(url, extension, fetcher) {
  try {
    const response = await fetcher(url, { signal: AbortSignal.timeout(10_000) });
    if (!response.ok || Number(response.headers.get("content-length") || 0) > maxMediaBytes || !response.body) return null;
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maxMediaBytes) return null;
        chunks.push(Buffer.from(value));
      }
    } finally { await reader.cancel().catch(() => {}); }
    const buffer = Buffer.concat(chunks, size);
    return validContent(buffer, extension) ? buffer : null;
  } catch { return null; }
}

// Cache files use IDs only (never event names or persisted arbitrary URLs) to avoid path
// traversal and SSRF. The cache remains in DATA_DIR across app deployments/re-scans.
export function createArchiveStore(root, { fetcher = fetch } = {}) {
  const inFlight = new Map();
  async function get(guildId, asset) {
    if (!/^\d{1,25}$/.test(String(guildId)) || !validAsset(asset.kind, asset.id)) return null;
    const directory = path.join(root, String(guildId), asset.kind);
    const desired = archiveUrls(asset);
    let fallback = null;
    for (const extension of extensions) {
      try {
        const buffer = await fs.readFile(path.join(directory, `${asset.id}.${extension}`));
        if (validContent(buffer, extension)) {
          const cached = { buffer, extension, cached: true };
          if (extension === desired[0]?.extension && !(asset.kind === "emoji" && asset.animated === true && extension === "webp" && !animatedWebp(buffer))) return cached;
          fallback ??= cached;
        }
      } catch (error) { if (error.code !== "ENOENT") throw error; }
    }
    for (const candidate of desired) {
      const buffer = await download(candidate.url, candidate.extension, fetcher);
      if (!buffer) continue;
      if (asset.kind === "emoji" && asset.animated === true && candidate.extension === "webp" && !animatedWebp(buffer)) continue;
      await fs.mkdir(directory, { recursive: true });
      const destination = path.join(directory, `${asset.id}.${candidate.extension}`);
      const temp = `${destination}.${crypto.randomUUID()}.tmp`;
      try {
        await fs.writeFile(temp, buffer, { flag: "wx" });
        await fs.rename(temp, destination);
      } finally { await fs.rm(temp, { force: true }); }
      return { buffer, extension: candidate.extension, cached: false };
    }
    return fallback;
  }
  return {
    get(guildId, asset) {
      const key = `${guildId}:${asset.kind}:${asset.id}`;
      if (inFlight.has(key)) return inFlight.get(key);
      const promise = get(guildId, asset).finally(() => inFlight.delete(key));
      inFlight.set(key, promise);
      return promise;
    }
  };
}

function safeName(asset) {
  return String(asset.names?.at(-1) || "unknown").replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 55) || "unknown";
}

export async function buildArchivePage(data, guildId, { scope = "all", attachmentLimit = 20 * 1024 * 1024, getMedia } = {}) {
  const candidates = archiveCandidates(data, scope);
  const pageCount = 1;
  const selected = candidates;
  const results = Array(selected.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(4, selected.length) }, async () => {
    while (next < selected.length) {
      const index = next++;
      const asset = selected[index];
      try {
        const media = await getMedia(guildId, asset);
        results[index] = { asset, media, error: media ? null : "CDNから取得できません（削除済み・権限・形式など）" };
      } catch (error) { results[index] = { asset, media: null, error: `保存エラー: ${error.message}` }; }
    }
  }));

  const budget = Math.floor(attachmentLimit) - 256 * 1024;
  if (budget < maxMediaBytes) throw new Error("Discordの添付ファイル上限が小さすぎます");
  const groups = [{ files: [], bytes: 0 }];
  const failures = [];
  for (const result of results) {
    if (!result.media) { failures.push(result); continue; }
    if (result.media.buffer.length > budget) { failures.push({ ...result, error: "添付サイズ上限を超えます" }); continue; }
    let group = groups.at(-1);
    if (group.files.length && group.bytes + result.media.buffer.length > budget) {
      group = { files: [], bytes: 0 };
      groups.push(group);
    }
    group.files.push(result);
    group.bytes += result.media.buffer.length;
  }
  const parts = [];
  for (const [index, group] of groups.entries()) {
    const zip = new JSZip();
    for (const { asset, media } of group.files) {
      zip.file(`${asset.ownership}/${asset.kind}/${safeName(asset)}_${asset.id}.${media.extension}`, media.buffer, { compression: "STORE" });
    }
    const manifest = {
      guildId, scope, pageCount, part: index + 1, parts: groups.length,
      files: group.files.map(({ asset, media }) => ({ ...asset, format: media.extension })),
      ...(index === 0 ? { failures: failures.map(({ asset, error }) => ({ ...asset, error })) } : {})
    };
    zip.file("manifest.json", `${JSON.stringify(manifest, null, 2)}\n`);
    const buffer = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 6 } });
    if (buffer.length > attachmentLimit) throw new Error("ZIPがDiscordの添付サイズ上限を超えました");
    parts.push({ name: `emoji_archive_${index + 1}.zip`, buffer });
  }
  return { parts, pageCount, total: candidates.length, selected: selected.length, saved: results.length - failures.length, failed: failures.length };
}
