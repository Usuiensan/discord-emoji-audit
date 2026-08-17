import "dotenv/config";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Client, Collection, Events, GatewayIntentBits, MessageFlags, Partials } from "discord.js";
import {
  SOURCE, assetKey, cloneData, guildData, loadDatabase, loadScanStage,
  currentAssetName, recordUsage, removeScanStage, report, saveDatabase, saveScanStage, syncAssets
} from "./audit.js";
import { addApplicationOwners, canRunScan, parseUserIds, scanCooldownRemaining } from "./authorization.js";
import { assetEventNames, commands } from "./discord-contract.js";
import { contentUsageEventsFromUpdate, isBotMessage, isExcludedChannel, reactionUsageEvent, usageEventsFromMessage } from "./message-events.js";
import { formatCompletion, formatCount, formatProgress } from "./progress.js";
import { buildReportXlsx, reportSummaryText } from "./report-xlsx.js";
import { scanConfig, scanResumeMatches } from "./scan-config.js";
import { channelMatchesScope, channelScopeKey, parseChannelIds } from "./scopes.js";

const token = process.env.DISCORD_TOKEN;
const dataFile = path.resolve(process.env.DATA_DIR ?? "./data", "audit.json");
const namePattern = process.env.EMOJI_NAME_PATTERN ?? "^[a-z0-9_]+$";
if (!token) throw new Error("DISCORD_TOKEN が必要です。.env.example を参照してください。");

const lockPath = path.resolve(path.dirname(dataFile), "discord-emoji-audit.lock");
fs.mkdirSync(path.dirname(lockPath), { recursive: true });
let lockFd;
try {
  lockFd = fs.openSync(lockPath, "wx");
} catch (error) {
  if (error.code !== "EEXIST") throw error;
  let ownerPid = null;
  try { ownerPid = Number(fs.readFileSync(lockPath, "utf8").trim()); } catch { /* stale or unreadable lock */ }
  let active = false;
  if (Number.isInteger(ownerPid) && ownerPid > 0) {
    try { process.kill(ownerPid, 0); active = true; } catch (probeError) { active = probeError.code !== "ESRCH"; }
  }
  if (active) throw new Error(`既に別のBotプロセスが起動中です (PID ${ownerPid})`);
  fs.rmSync(lockPath, { force: true });
  lockFd = fs.openSync(lockPath, "wx");
}
fs.writeFileSync(lockFd, `${process.pid}\n`, "utf8");
process.once("exit", () => {
  try { fs.closeSync(lockFd); } catch { /* already closed */ }
  try { fs.rmSync(lockPath, { force: true }); } catch { /* process exit cleanup is best effort */ }
});

const db = loadDatabase(dataFile);
const client = new Client({ partials: [Partials.Message, Partials.Channel, Partials.Reaction], intents: [
  GatewayIntentBits.Guilds,
  GatewayIntentBits.GuildMessages,
  GatewayIntentBits.GuildMessageReactions,
  GatewayIntentBits.MessageContent
] });
const scanLocks = new Set();
const progressThrottle = new Map();
const privateInteractions = new Map();
const botOwnerIds = parseUserIds(process.env.BOT_OWNER_USER_IDS);
const scanCooldownMs = 5 * 60 * 1000;

function parseExcludedChannelIds(value) {
  return [...new Set(String(value ?? "").split(/[\s,]+/).map((token) => token.match(/^<?#?(\d+)>?$/)?.[1]).filter(Boolean))];
}

function scanEventIsExcluded(scan, event) {
  return (scan.excludeBots && (event.authorIsBot || event.reactorIsBot))
    || isExcludedChannel({ id: event.channelId, parentId: event.parentChannelId }, scan.excludedChannelIds)
    || !channelMatchesScope({ id: event.channelId, parentId: event.parentChannelId }, scan.rootChannelIds, scan.channelIds);
}

function assetIsCountable(data, kind, id) {
  const asset = data.assets[assetKey(kind, id)];
  return Boolean(asset && (asset.current || data.lineages[asset.lineageId]?.confirmedAt));
}

function applyUsageEvent(data, event, scan = data.scan) {
  if (scanEventIsExcluded(scan, event)) return false;
  const asset = data.assets[assetKey(event.kind, event.id)];
  if (!asset || !assetIsCountable(data, event.kind, event.id)) return false;
  const recorded = recordUsage(data, event.kind, event.id, event.date, event.source, event.count, { name: event.name });
  if (!recorded || !event.channelId) return recorded;
  const aggregateDaily = data.daily;
  data.channelDaily ??= {};
  data.daily = (data.channelDaily[event.channelId] ??= {});
  recordUsage(data, event.kind, event.id, event.date, event.source, event.count, { name: event.name });
  data.daily = aggregateDaily;
  return recorded;
}

function applyScanEvents(data, scan, events) {
  for (const event of events) {
    if (!applyUsageEvent(data, event, scan)) continue;
    const count = event.count ?? 0;
    if (event.source === SOURCE.CONTENT) scan.contentUsages = (scan.contentUsages ?? 0) + count;
    else if (event.source === SOURCE.STICKER) scan.stickerUsages = (scan.stickerUsages ?? 0) + count;
    else if ([SOURCE.REACTION_APPROX, SOURCE.REACTION_EXACT].includes(event.source)) scan.reactionUsages = (scan.reactionUsages ?? 0) + count;
  }
}

function liveJournalPath(guildId) {
  return path.resolve(path.dirname(dataFile), `scan-live-${guildId}.jsonl`);
}

function appendLiveEvents(guild, events) {
  const serializable = events;
  fs.mkdirSync(path.dirname(dataFile), { recursive: true });
  const fd = fs.openSync(liveJournalPath(guild.id), "a");
  try {
    fs.writeSync(fd, `${serializable.map((event) => JSON.stringify(event)).join("\n")}\n`, null, "utf8");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function readLiveEvents(guildId, offset = 0) {
  const filePath = liveJournalPath(guildId);
  if (!fs.existsSync(filePath)) return { events: [], endOffset: 0 };
  const bytes = fs.readFileSync(filePath);
  if (offset > bytes.length) offset = 0;
  const text = bytes.subarray(offset).toString("utf8");
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const events = [];
  for (const line of lines) {
    if (!line) continue;
    try { events.push(JSON.parse(line)); } catch { break; }
  }
  const consumedText = `${events.map((event) => JSON.stringify(event)).join("\n")}${events.length ? "\n" : ""}`;
  return { events, endOffset: offset + Buffer.byteLength(consumedText) };
}

function eventIsAfterScanStart(event, startedAt) {
  if (event.source === SOURCE.REACTION_REMOVE) return true;
  const started = Date.parse(startedAt ?? "");
  const created = Date.parse(event.messageCreatedAt ?? "");
  return Number.isFinite(started) && Number.isFinite(created) && created > started;
}

function recordDeferredEvent(data, event) {
  data.scan.deferredEventDetails ??= [];
  data.scan.deferredEventDetails.push({
    messageId: event.messageId ?? null,
    messageCreatedAt: event.messageCreatedAt ?? null,
    channelId: event.channelId ?? null,
    parentChannelId: event.parentChannelId ?? null,
    kind: event.kind ?? null,
    id: event.id ?? null,
    name: event.name ?? null,
    date: event.date ?? null,
    source: event.source ?? null,
    count: event.count ?? 0
  });
}

function applyLiveJournalToStage(guild, data, stage) {
  const offset = data.scan.liveAppliedOffset ?? 0;
  const { events, endOffset } = readLiveEvents(guild.id, offset);
  let deferred = 0;
  for (const event of events) {
    if (!eventIsAfterScanStart(event, data.scan.startedAt)) {
      deferred++;
      recordDeferredEvent(data, event);
      continue;
    }
    if (!scanEventIsExcluded(data.scan, event)) {
      applyUsageEvent(stage.working, event, data.scan);
      applyEventToSavedScopes(data, event);
    }
  }
  data.scan.deferredEvents = (data.scan.deferredEvents ?? 0) + deferred;
  data.scan.liveAppliedOffset = endOffset;
  data.scan.pendingLiveEvents = 0;
  if (events.length) data.lastEventAt = new Date().toISOString();
}

function applyEventToStore(data, store, event, scan) {
  const target = { ...data, daily: store.daily, channelDaily: store.channelDaily ?? {}, scan };
  const recorded = applyUsageEvent(target, event, scan);
  store.daily = target.daily;
  store.channelDaily = target.channelDaily;
  return recorded;
}

function applyEventToSavedScopes(data, event) {
  const allScan = allScopeScan(data);
  const allStore = { daily: data.daily, channelDaily: data.channelDaily ?? {} };
  applyEventToStore(data, allStore, event, allScan);
  data.daily = allStore.daily;
  data.channelDaily = allStore.channelDaily;
  for (const [key, snapshot] of Object.entries(data.scopeReports ?? {})) {
    if (key === "all" || !snapshot.daily || !snapshot.scan) continue;
    applyEventToStore(data, snapshot, event, snapshot.scan);
  }
}

function applyLiveJournalToDatabase(guild, data) {
  const offset = data.scan.liveAppliedOffset ?? 0;
  const { events, endOffset } = readLiveEvents(guild.id, offset);
  for (const event of events) {
    if (!eventIsAfterScanStart(event, data.scan.startedAt)) {
      data.scan.deferredEvents = (data.scan.deferredEvents ?? 0) + 1;
      recordDeferredEvent(data, event);
    } else applyEventToSavedScopes(data, event);
  }
  data.scan.liveAppliedOffset = endOffset;
  if (events.length) data.lastEventAt = new Date().toISOString();
}

function countPendingLiveEvents(guild, data) {
  return readLiveEvents(guild.id, data.scan.liveAppliedOffset ?? 0).events.length;
}

function compactLiveJournal(guild, data) {
  const filePath = liveJournalPath(guild.id);
  if (fs.existsSync(filePath)) fs.rmSync(filePath, { force: true });
  data.scan.liveAppliedOffset = 0;
}

function recoverCompletedLiveEvents(guild, data) {
  if (["running", "failed"].includes(data.scan.status)) return false;
  applyLiveJournalToDatabase(guild, data);
  compactLiveJournal(guild, data);
  return true;
}

function recordOrQueue(guild, events) {
  if (!events.length) return;
  const data = guildData(db, guild.id);
  if (scanLocks.has(guild.id)) {
    const relevant = events.filter((event) => event.kind === "emoji" || event.kind === "sticker");
    try { if (relevant.length) appendLiveEvents(guild, relevant); } catch (error) {
      data.scan.error = `走査中イベント保存失敗: ${error.message}`;
      console.error(`走査中イベント保存失敗 (${guild.id}): ${error.stack ?? error.message}`);
    }
    return;
  }
  for (const event of events) applyEventToSavedScopes(data, event);
  data.lastEventAt = new Date().toISOString();
  saveDatabase(dataFile, db);
}

function stagePath(runId, guildId = "") {
  return path.resolve(path.dirname(dataFile), `scan-${guildId}-${runId}.json`);
}

function emojiMention(asset) {
  const name = currentAssetName(asset) || "emoji";
  return `<${asset.animated ? "a" : ""}:${name}:${asset.id}>`;
}

function allScopeScan(data) {
  if (data.scopeReports?.all?.scan) return data.scopeReports.all.scan;
  if (!data.scan?.scopeKey || data.scan.scopeKey === "all") return data.scan;
  return { ...data.scan, status: "never", scopeKey: "all", rootChannelIds: [], channelIds: [], excludedChannelIds: [], excludeBots: false };
}

function scopeSnapshot(data, rootChannelIds = []) {
  const key = channelScopeKey(rootChannelIds);
  if (key === "all") {
    const meta = data.scopeReports?.all ?? {};
    const legacyAll = !data.scan?.scopeKey || data.scan.scopeKey === "all";
    return {
      scopeKey: key,
      rootChannelIds: meta.rootChannelIds ?? [],
      channelIds: meta.channelIds ?? (legacyAll ? data.scan?.channelIds ?? [] : []),
      channelNames: meta.channelNames ?? (legacyAll ? data.scan?.channelNames ?? {} : {}),
      daily: data.daily,
      channelDaily: data.channelDaily ?? {},
      scan: allScopeScan(data)
    };
  }
  return data.scopeReports?.[key] ?? null;
}

function reportRows(data, snapshot, days, limit, channelId = null) {
  if (!snapshot) return [];
  const daily = channelId ? snapshot.channelDaily?.[channelId] ?? {} : snapshot.daily ?? {};
  return report({ ...data, daily }, { days, limit, namePattern });
}

function compactRankingText(data, snapshot) {
  const days = snapshot?.scan?.reportDays ?? 30;
  const format = (rows) => rows.map(({ asset, recent }) => `${asset.kind === "emoji" ? `${emojiMention(asset)} ` : ""}\`${String(currentAssetName(asset) || "?").replaceAll("`", "'")}\` — ${formatCount(recent)}件`).join("\n");
  return ["emoji", "sticker"].flatMap((kind) => {
    const rows = reportRows(data, snapshot, days, null).filter((row) => row.asset.kind === kind);
    if (!rows.length) return [];
    const top = [...rows].sort((a, b) => b.recent - a.recent || b.stats.all - a.stats.all).slice(0, 3);
    const topIds = new Set(top.map((row) => row.asset.id));
    const bottom = [...rows].sort((a, b) => a.recent - b.recent || a.stats.all - b.stats.all).filter((row) => !topIds.has(row.asset.id)).slice(0, 3);
    const label = kind === "emoji" ? "絵文字" : "スタンプ";
    return [`**${label}・直近${days}日 上位**\n${format(top)}`, ...(bottom.length ? [`**${label}・直近${days}日 下位**\n${format(bottom)}`] : [])];
  }).join("\n\n");
}

function intermediatePayload(data) {
  return {
    content: intermediateText(data),
    embeds: [],
  };
}

function intermediateText(data) {
  const scan = data.scan;
  const mention = scan.requesterId ? `<@${scan.requesterId}>\n` : "";
  return `${mention}**使用状況を調査中**\n${formatProgress(scan)}`;
}

async function updateProgressMessage(guild, data, force = false) {
  const scan = data.scan;
  const now = Date.now();
  if (!force && now - (progressThrottle.get(guild.id) ?? 0) < 5000) return;
  progressThrottle.set(guild.id, now);
  if (scan.onlyMe) {
    const interaction = privateInteractions.get(guild.id);
    if (!interaction) return;
    try {
      await interaction.editReply({ ...intermediatePayload(data), allowedMentions: { parse: [] } });
    } catch (error) {
      scan.progressError = error.message;
      console.warn(`非公開進捗メッセージ更新失敗 (${guild.id}): ${error.message}`);
    }
    return;
  }
  if (!scan.progressChannelId || !scan.progressMessageId) return;
  try {
    const channel = guild.channels.cache.get(scan.progressChannelId) ?? await guild.channels.fetch(scan.progressChannelId);
    const message = await channel.messages.fetch(scan.progressMessageId);
    await message.edit({ ...intermediatePayload(data), allowedMentions: { parse: [] } });
  } catch (error) {
    scan.progressError = error.message;
    console.warn(`進捗メッセージ更新失敗 (${guild.id}): ${error.message}`);
  }
}

async function findProgressMessage(guild, data, fallback = null) {
  const scan = data.scan;
  try {
    if (fallback) return { channel: fallback.channel, message: fallback };
    if (scan.progressChannelId && scan.progressMessageId) {
      const channel = guild.channels.cache.get(scan.progressChannelId) ?? await guild.channels.fetch(scan.progressChannelId);
      const message = await channel.messages.fetch(scan.progressMessageId);
      return { channel, message };
    }
  } catch (error) {
    console.warn(`中間報告メッセージ取得失敗 (${guild.id}): ${error.message}`);
  }
  return null;
}

function scanResultPayload(data, { mentionId = null, error = null, onlyMe = data.scan.onlyMe, snapshot = null } = {}) {
  const target = snapshot ?? scopeSnapshot(data, data.scan.rootChannelIds);
  const scan = error ? data.scan : target?.scan ?? data.scan;
  const mention = mentionId ? `<@${mentionId}>\n` : "";
  const body = error
    ? `${mention}初期スキャンを停止しました。既存の確定済み集計は維持しています。\n${formatProgress(scan)}\n理由: ${error.message}`
    : `${mention}**集計が完了しました。**\n${formatCompletion(scan)}\n\n${compactRankingText(data, target)}`;
  const flags = onlyMe ? MessageFlags.Ephemeral | MessageFlags.SuppressNotifications : MessageFlags.SuppressNotifications;
  return { content: body.slice(0, 1900), allowedMentions: mentionId ? { users: [mentionId] } : { parse: [] }, flags };
}

async function postScanResult(guild, data, progressMessage, error = null) {
  const snapshot = error ? null : scopeSnapshot(data, data.scan.rootChannelIds);
  if (data.scan.onlyMe) {
    const interaction = privateInteractions.get(guild.id);
    if (!interaction) return;
    const payload = scanResultPayload(data, { mentionId: data.scan.requesterId, error, onlyMe: true, snapshot });
    try {
      await interaction.editReply(payload);
    } catch (sendError) {
      console.error(`非公開スキャン結果通知失敗 (${guild.id}): ${sendError.stack ?? sendError.message}`);
    }
    return;
  }
  const target = await findProgressMessage(guild, data, progressMessage);
  if (!target?.channel?.send) return;
  const scan = data.scan;
  const payload = scanResultPayload(data, { mentionId: scan.requesterId, error, snapshot });
  try {
    await target.channel.send(payload);
  } catch (sendError) {
    console.error(`スキャン結果通知失敗 (${guild.id}): ${sendError.stack ?? sendError.message}`);
    try {
      await target.message.edit({
        content: `${payload.content}\n結果通知の新規投稿に失敗したため、このメッセージを残しています。`.slice(0, 1900),
        allowedMentions: { parse: [] }
      });
    } catch (editError) {
      console.warn(`結果通知失敗表示も失敗 (${guild.id}): ${editError.message}`);
    }
    return;
  }
  try {
    await target.message.delete();
  } catch (deleteError) {
    console.warn(`中間報告メッセージ整理失敗 (${guild.id}): ${deleteError.message}`);
    try {
      await target.message.edit({
        content: `${payload.content}\n中間報告メッセージを整理できなかったため、結果通知が重複しています。`.slice(0, 1900),
        allowedMentions: { parse: [] }
      });
    } catch (editError) {
      console.warn(`中間報告の整理失敗表示も失敗 (${guild.id}): ${editError.message}`);
    }
  }
}

async function collectChannels(guild, scan) {
  const channels = new Collection();
  scan.discoveryErrors ??= [];
  const fetched = await retryUntilSuccess(() => guild.channels.fetch(), `チャンネル一覧 (${guild.id})`);
  // VoiceChannel/StageChannelもテキストメッセージを持つため、Connect権限で走査対象に含める。
  for (const channel of fetched.values()) if (channel?.isTextBased?.() && channel.guild?.id === guild.id) channels.set(channel.id, channel);
  try {
    const active = await retryUntilSuccess(() => guild.channels.fetchActiveThreads(), `アクティブスレッド (${guild.id})`);
    for (const thread of active.threads.values()) channels.set(thread.id, thread);
  } catch (error) {
    scan.discoveryErrors.push(`active_threads: ${error.message}`);
  }
  for (const channel of channels.values()) {
    if (!channel.threads?.fetchArchived) continue;
    for (const type of ["public", "private"]) {
      try {
        const archived = await retryUntilSuccess(() => channel.threads.fetchArchived({ type, fetchAll: true }), `アーカイブ済みスレッド (${channel.id}/${type})`);
        for (const thread of archived.threads.values()) channels.set(thread.id, thread);
      } catch (error) {
        scan.discoveryErrors.push(`${channel.id}:archived_${type}: ${error.message}`);
      }
    }
  }
  const missing = (scan.rootChannelIds ?? []).filter((channelId) => !channels.has(channelId));
  if (missing.length) throw new Error(`指定チャンネルを取得できません: ${missing.join(", ")}`);
  for (const [channelId, channel] of channels) {
    if (!channelMatchesScope(channel, scan.rootChannelIds) || isExcludedChannel(channel, scan.excludedChannelIds)) channels.delete(channelId);
  }
  scan.channelTotalKnown = true;
  scan.channelCount = [...channels.values()].filter((channel) => !channel.isThread?.()).length;
  scan.threadCount = [...channels.values()].filter((channel) => channel.isThread?.()).length;
  scan.channelNames = Object.fromEntries([...channels.values()].map((channel) => [channel.id, channel.name ?? channel.id]));
  return channels;
}

async function retry(operation, attempts = 3) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    try { return await operation(); } catch (error) {
      if ([10003, 50001, 50013].includes(Number(error.code)) || attempt === attempts - 1) throw error;
      await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
    }
  }
}

async function fetchMessagePage(channel, options) {
  return retry(() => channel.messages.fetch(options));
}

function isPermanentFetchError(error) {
  return [10003, 50001, 50013].includes(Number(error.code));
}

function waitForRetry(delay = 10000) {
  return new Promise((resolve) => setTimeout(resolve, delay));
}

async function retryUntilSuccess(operation, label) {
  let delay = 10000;
  for (let attempt = 0; attempt < 10; attempt++) {
    try { return await retry(operation); } catch (error) {
      if (isPermanentFetchError(error) || attempt === 9) throw error;
      console.warn(`${label}を再試行します: ${error.message}`);
      await waitForRetry(delay);
      delay = Math.min(delay * 2, 60000);
    }
  }
}

async function commitScan(guild, data, stage, status = "complete") {
  const assets = await fetchCurrentAssets(guild);
  if (!assets) {
    data.assetsAvailable = "unknown";
    throw new Error("反映直前の絵文字・スタンプ一覧を取得できませんでした。結果は未反映です");
  }
  data.assetsAvailable = "confirmed";
  for (const [key, observed] of Object.entries(data.assets)) {
    const target = stage.working.assets[key] ??= cloneData(observed);
    for (const name of observed.names ?? []) if (!target.names.includes(name)) target.names.push(name);
    target.nameHistory ??= [];
    for (const entry of observed.nameHistory ?? []) if (!target.nameHistory.some((known) => known.name === entry.name)) target.nameHistory.push(entry);
    target.firstObservedAt = [target.firstObservedAt, observed.firstObservedAt].filter(Boolean).sort()[0] ?? target.firstObservedAt;
    target.lastObservedAt = [target.lastObservedAt, observed.lastObservedAt].filter(Boolean).sort().at(-1) ?? target.lastObservedAt;
    if (data.lineages[observed.lineageId]?.confirmedAt) target.lineageId = observed.lineageId;
  }
  syncAssets(stage.working, assets);
  for (const [lineageId, observed] of Object.entries(data.lineages)) {
    if (!observed.confirmedAt) continue;
    const target = stage.working.lineages[lineageId] = cloneData(observed);
    for (const key of target.members) if (stage.working.assets[key]) stage.working.assets[key].lineageId = lineageId;
  }
  data.scan.phase = "commit";
  await updateProgressMessage(guild, data, true);
  applyLiveJournalToStage(guild, data, stage);
  data.assets = stage.working.assets;
  data.lineages = stage.working.lineages;
  data.scan.status = status;
  data.scan.finishedAt = new Date().toISOString();
  data.scan.phase = "done";
  const snapshot = {
    scopeKey: data.scan.scopeKey,
    rootChannelIds: [...(data.scan.rootChannelIds ?? [])],
    channelIds: [...(data.scan.channelIds ?? [])],
    channelNames: cloneData(data.scan.channelNames ?? {}),
    daily: stage.working.daily,
    channelDaily: stage.working.channelDaily ?? {},
    scan: cloneData(data.scan)
  };
  if (data.scan.scopeKey === "all") {
    data.daily = snapshot.daily;
    data.channelDaily = snapshot.channelDaily;
    data.scopeReports.all = {
      scopeKey: "all",
      rootChannelIds: snapshot.rootChannelIds,
      channelIds: snapshot.channelIds,
      channelNames: snapshot.channelNames,
      scan: snapshot.scan
    };
  } else {
    data.scopeReports[data.scan.scopeKey] = snapshot;
  }
  saveDatabase(dataFile, db, { backup: true });
  removeScanStage(stage.filePath);
  await updateProgressMessage(guild, data, true);
}

async function scanGuild(guild, progressMessage = null, options = {}) {
  if (scanLocks.has(guild.id)) throw new Error("このサーバーは既に走査中です");
  scanLocks.add(guild.id);
  const data = guildData(db, guild.id);
  let stage;
  try {
    const resuming = ["running", "failed"].includes(data.scan.status) && data.scan.runId;
    const runId = resuming ? data.scan.runId : `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
    const filePath = stagePath(runId, guild.id);
    if (resuming) {
      try { stage = loadScanStage(filePath); } catch (error) { throw new Error(`走査チェックポイントを読み込めません。消去せずバックアップ後に再確認してください: ${error.message}`); }
      if (!stage) throw new Error("走査チェックポイントが見つかりません。消去せずバックアップ後に再確認してください");
    }
    if (!stage) {
      const assets = await fetchCurrentAssets(guild);
      if (!assets) {
        data.assetsAvailable = "unknown";
        throw new Error("現在の絵文字・スタンプ一覧を完全には取得できませんでした");
      }
      data.assetsAvailable = "confirmed";
      const working = cloneData(data);
      working.daily = {};
      working.channelDaily = {};
      syncAssets(working, assets);
      syncAssets(data, assets);
      if (recoverCompletedLiveEvents(guild, data)) saveDatabase(dataFile, db);
      if (fs.existsSync(liveJournalPath(guild.id))) {
        const orphanPath = `${liveJournalPath(guild.id)}.${data.scan.runId ?? Date.now()}.orphan`;
        fs.renameSync(liveJournalPath(guild.id), orphanPath);
        console.warn(`前回の未反映イベントログを保管しました: ${orphanPath}`);
      }
      data.scan = {
        status: "running", runId, startedAt: new Date().toISOString(), finishedAt: null, phase: "discover",
        messages: 0, pages: 0, channelIndex: 0, channelTotal: 0, channelTotalKnown: false, messageTotalKnown: false, channelCount: 0, threadCount: 0,
        processedChannels: 0, processedThreads: 0, currentChannelId: null, currentChannelName: null,
        skippedChannels: [], discoveryErrors: [], progressChannelId: progressMessage?.channelId ?? null,
        progressMessageId: progressMessage?.id ?? null, requesterId: options.requesterId ?? null,
        reportDays: options.reportDays ?? 30, reportLimit: options.reportLimit ?? 10, scanDays: options.scanDays ?? null,
        excludeBots: options.excludeBots ?? false, excludedChannelIds: options.excludedChannelIds ?? [], onlyMe: options.onlyMe ?? false,
        contentUsages: 0, stickerUsages: 0, reactionUsages: 0,
        progressError: null, deferredEvents: 0, deferredEventDetails: [], pendingLiveEvents: 0, liveAppliedOffset: 0,
        scopeKey: options.scopeKey ?? "all", rootChannelIds: options.rootChannelIds ?? [], channelIds: [], channelNames: {}
      };
      stage = { version: 1, runId, filePath, config: scanConfig(data.scan), working, progress: cloneData(data.scan) };
      saveScanStage(filePath, stage);
      saveDatabase(dataFile, db, { backup: true });
    } else {
      stage.filePath = filePath;
      if (!scanResumeMatches(stage.config ?? stage.progress, options)) {
        throw new Error("前回失敗した走査と実行条件が異なります。同じ条件で再開するか、チェックポイントをバックアップしてから新規走査してください");
      }
      data.scan = stage.progress;
      data.scan.status = "running";
      data.scan.requesterId = options.requesterId ?? data.scan.requesterId ?? null;
      data.scan.channelIds ??= [];
      data.scan.channelNames ??= {};
      data.scan.contentUsages ??= 0;
      data.scan.stickerUsages ??= 0;
      data.scan.reactionUsages ??= 0;
      if (progressMessage) {
        data.scan.progressChannelId = progressMessage.channelId;
        data.scan.progressMessageId = progressMessage.id;
      }
    }
    await updateProgressMessage(guild, data, true);
    const channels = await collectChannels(guild, data.scan);
    const channelIds = stage.progress.channelIds?.length ? stage.progress.channelIds : [...channels.keys()];
    stage.progress.channelIds = channelIds;
    stage.progress.channelTotal = channelIds.length;
    stage.progress.channelTotalKnown = data.scan.channelTotalKnown;
    stage.progress.channelCount = data.scan.channelCount;
    stage.progress.threadCount = data.scan.threadCount;
    if (!Number.isInteger(stage.progress.processedChannels) || !Number.isInteger(stage.progress.processedThreads)) {
      stage.progress.processedChannels = 0;
      stage.progress.processedThreads = 0;
      for (const channelId of channelIds.slice(0, data.scan.channelIndex)) {
        if (channels.get(channelId)?.isThread?.()) stage.progress.processedThreads++;
        else stage.progress.processedChannels++;
      }
    }
    data.scan.channelIds = channelIds;
    data.scan.channelNames = Object.fromEntries([...channels.values()].map((channel) => [channel.id, channel.name ?? channel.id]));
    stage.working.channelDaily ??= {};
    for (const channelId of channelIds) stage.working.channelDaily[channelId] ??= {};
    data.scan.channelTotal = channelIds.length;
    data.scan.processedChannels = stage.progress.processedChannels;
    data.scan.processedThreads = stage.progress.processedThreads;
    data.scan.phase = "history";
    saveScanStage(filePath, stage);
    saveDatabase(dataFile, db);
    for (let index = data.scan.channelIndex; index < channelIds.length; index++) {
      const channel = channels.get(channelIds[index]);
      data.scan.channelIndex = index;
      data.scan.currentChannelId = channel?.id ?? channelIds[index];
      data.scan.currentChannelName = channel?.name ?? "取得不能チャンネル";
      if (!channel?.messages?.fetch) {
        data.scan.skippedChannels.push(`${channelIds[index]}: messages API unavailable`);
      } else {
        let before = stage.progress.before ?? null;
        let completed = false;
        const scanSince = data.scan.scanDays === null
          ? null
          : Date.parse(data.scan.startedAt) - data.scan.scanDays * 86400000;
        let retryDelay = 10000;
        let retryCount = 0;
        while (!completed) {
          try {
            while (true) {
              const batch = await fetchMessagePage(channel, { limit: 100, ...(before ? { before } : {}) });
              if (!batch.size) break;
              let reachedScanSince = false;
              for (const message of batch.values()) {
                const createdAt = Date.parse(message.createdAt);
                if (createdAt <= Date.parse(data.scan.startedAt) && (scanSince === null || createdAt >= scanSince)) {
                  if (message.content) data.contentAvailable = "observed";
                  applyScanEvents(stage.working, data.scan, usageEventsFromMessage(message, message.createdAt, true, client.user?.id, data.scan.excludeBots));
                  data.scan.messages++;
                }
                if (scanSince !== null && createdAt < scanSince) reachedScanSince = true;
              }
              before = batch.last().id;
              data.scan.pages++;
              stage.progress = cloneData(data.scan);
              stage.progress.before = before;
              saveScanStage(filePath, stage);
              if (data.scan.pages % 10 === 0) saveDatabase(dataFile, db);
              await updateProgressMessage(guild, data);
              if (batch.size < 100 || reachedScanSince) break;
            }
            completed = true;
          } catch (error) {
            if (isPermanentFetchError(error)) {
              data.scan.skippedChannels.push(`${channel.id}: ${error.message}`);
              completed = true;
              continue;
            }
            retryCount++;
            if (retryCount >= 10) {
              data.scan.skippedChannels.push(`${channel.id}: 一時的な取得失敗が10回続いたため対象外にしました (${error.message})`);
              completed = true;
              continue;
            }
            console.warn(`チャンネル取得を再試行します (${guild.id}/${channel.id}): ${error.message}`);
            await waitForRetry(retryDelay);
            retryDelay = Math.min(retryDelay * 2, 60000);
          }
        }
      }
      stage.progress.before = null;
      data.scan.channelIndex = index + 1;
      if (channel?.isThread?.()) data.scan.processedThreads++;
      else data.scan.processedChannels++;
      data.scan.currentChannelId = null;
      data.scan.currentChannelName = null;
      stage.progress = cloneData(data.scan);
      stage.progress.channelIds = channelIds;
      saveScanStage(filePath, stage);
      saveDatabase(dataFile, db);
      await updateProgressMessage(guild, data);
    }
    data.scan.status = data.scan.skippedChannels.length ? "partial" : data.scan.deferredEvents ? "complete_with_deferred" : "complete";
    data.scan.phase = "done";
    stage.progress = cloneData(data.scan);
    saveScanStage(filePath, stage);
    await commitScan(guild, data, { ...stage, filePath }, data.scan.status);
  } catch (error) {
    if (stage) {
      data.scan.liveAppliedOffset = stage.progress.liveAppliedOffset ?? 0;
      data.scan.deferredEvents = stage.progress.deferredEvents ?? 0;
    }
    data.scan.status = "failed";
    data.scan.phase = "done";
    data.scan.error = error.message;
    saveDatabase(dataFile, db);
    await updateProgressMessage(guild, data, true);
    throw error;
  } finally {
    if (data.scan.status === "failed") {
      data.scan.pendingLiveEvents = countPendingLiveEvents(guild, data);
    } else {
      applyLiveJournalToDatabase(guild, data);
      if (data.scan.status === "complete" && data.scan.deferredEvents) data.scan.status = "complete_with_deferred";
      saveDatabase(dataFile, db);
      compactLiveJournal(guild, data);
    }
    saveDatabase(dataFile, db);
    scanLocks.delete(guild.id);
    await updateProgressMessage(guild, data, true);
  }
}

function markEvent(guild) {
  const data = guildData(db, guild.id);
  data.lastEventAt = new Date().toISOString();
  saveDatabase(dataFile, db);
  return data;
}

async function fetchCurrentAssets(guild) {
  const [emojiResult, stickerResult] = await Promise.allSettled([guild.emojis.fetch(), guild.stickers.fetch()]);
  if (emojiResult.status === "rejected" || stickerResult.status === "rejected") {
    console.warn(`現在資産一覧取得失敗 (${guild.id})。母集団を更新しません。`);
    return null;
  }
  const emojis = emojiResult.value;
  const stickers = stickerResult.value;
  return [
    ...emojis.values().map((emoji) => ({ kind: "emoji", id: emoji.id, name: emoji.name, managed: emoji.managed, animated: emoji.animated })),
    ...stickers.values().map((sticker) => ({ kind: "sticker", id: sticker.id, name: sticker.name, url: sticker.url, format: sticker.format }))
  ];
}

client.once(Events.ClientReady, async (readyClient) => {
  console.log(`ログイン: ${readyClient.user.tag}`);
  addApplicationOwners(botOwnerIds, readyClient.application.owner);
  for (const guild of readyClient.guilds.cache.values()) {
    const data = guildData(db, guild.id);
    try {
      await readyClient.application.commands.set(commands, guild.id);
      const assets = await fetchCurrentAssets(guild);
      if (assets) { data.assetsAvailable = "confirmed"; syncAssets(data, assets); } else data.assetsAvailable = "unknown";
      if (assets && recoverCompletedLiveEvents(guild, data)) saveDatabase(dataFile, db);
    } catch (error) {
      data.assetsAvailable = "unknown";
      data.scan.error = `起動時同期: ${error.message}`;
      console.error(`起動時同期失敗 (${guild.id}): ${error.stack ?? error.message}`);
    }
  }
  saveDatabase(dataFile, db);
});

client.on(Events.GuildCreate, async (guild) => {
  const data = guildData(db, guild.id);
  try {
    await guild.commands.set(commands);
    const assets = await fetchCurrentAssets(guild);
    if (assets) { data.assetsAvailable = "confirmed"; syncAssets(data, assets); } else data.assetsAvailable = "unknown";
  } catch (error) {
    data.assetsAvailable = "unknown";
    data.scan.error = `参加時同期: ${error.message}`;
    console.error(`参加時同期失敗 (${guild.id}): ${error.stack ?? error.message}`);
  }
  saveDatabase(dataFile, db);
});

async function refreshAssetsAfterChange(guild) {
  const data = markEvent(guild);
  const assets = await fetchCurrentAssets(guild);
  if (assets) {
    data.assetsAvailable = "confirmed";
    syncAssets(data, assets);
  } else data.assetsAvailable = "unknown";
  saveDatabase(dataFile, db);
}

for (const eventName of assetEventNames) {
  client.on(Events[eventName], (asset) => {
    if (asset.guild) refreshAssetsAfterChange(asset.guild).catch((error) => console.error(`資産同期失敗 (${asset.guild.id}): ${error.stack ?? error.message}`));
  });
}

client.on(Events.MessageCreate, (message) => {
  if (!message.guild || isBotMessage(message, client.user?.id)) return;
  const data = guildData(db, message.guild.id);
  if (message.content) data.contentAvailable = "observed";
  recordOrQueue(message.guild, usageEventsFromMessage(message, new Date(), false, client.user?.id));
});

client.on(Events.MessageUpdate, (oldMessage, newMessage) => {
  if (!newMessage.guild || !newMessage.content || isBotMessage(newMessage, client.user?.id)) return;
  const data = guildData(db, newMessage.guild.id);
  data.contentAvailable = "observed";
  recordOrQueue(newMessage.guild, contentUsageEventsFromUpdate(oldMessage, newMessage, new Date(), client.user?.id));
});

client.on(Events.MessageReactionAdd, (reaction, user) => {
  const guild = reaction.message.guild ?? client.guilds.cache.get(reaction.message.guildId);
  if (!guild) return;
  const event = reactionUsageEvent(reaction, new Date(), SOURCE.REACTION_EXACT, client.user?.id, false, user);
  if (event) recordOrQueue(guild, [event]);
});

client.on(Events.MessageReactionRemove, (reaction, user) => {
  const guild = reaction.message.guild ?? client.guilds.cache.get(reaction.message.guildId);
  if (!guild) return;
  const event = reactionUsageEvent(reaction, new Date(), SOURCE.REACTION_REMOVE, client.user?.id, false, user);
  if (event) recordOrQueue(guild, [event]);
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand() || !["scan", "report"].includes(interaction.commandName)) return;
  if (!interaction.guild) return interaction.reply({ content: "サーバー内で実行してください。", ephemeral: true });
  const data = guildData(db, interaction.guild.id);
  if (interaction.commandName === "report") {
    let rootChannelIds;
    try { rootChannelIds = parseChannelIds(interaction.options.getString("channels")); } catch (error) {
      return interaction.reply({ content: error.message, ephemeral: true });
    }
    const snapshot = scopeSnapshot(data, rootChannelIds);
    if (!snapshot || !["complete", "complete_with_deferred", "partial", "partial_accepted"].includes(snapshot.scan?.status)) {
      return interaction.reply({ content: "再表示できる完了済みの調査結果がありません。先に `/scan` を実行してください。", ephemeral: true });
    }
    const onlyMe = interaction.options.getBoolean("only_me") ?? false;
    const flags = onlyMe ? MessageFlags.Ephemeral | MessageFlags.SuppressNotifications : MessageFlags.SuppressNotifications;
    await interaction.deferReply({ flags });
    try {
      const attachment = await buildReportXlsx(data, snapshot);
      const date = (snapshot.scan.finishedAt ?? new Date().toISOString()).slice(0, 10);
      await interaction.editReply({
        content: reportSummaryText(data, snapshot),
        files: [{ attachment, name: `emoji_count_${date}.xlsx` }],
        allowedMentions: { parse: [] }
      });
    } catch (error) {
      console.error(`棚卸しレポート生成失敗 (${interaction.guild.id}): ${error.stack ?? error.message}`);
      await interaction.editReply({ content: `棚卸しレポートを生成できませんでした: ${error.message}`, allowedMentions: { parse: [] } });
    }
    return;
  }
  if (!canRunScan({ userId: interaction.user.id, memberPermissions: interaction.memberPermissions, botOwnerIds })) {
    return interaction.reply({ content: "`/scan` はサーバー管理者、Bot所有者、または指定運用者だけが実行できます。", ephemeral: true });
  }
  if (data.scan.status === "running" && scanLocks.has(interaction.guild.id)) return interaction.reply({ content: data.scan.onlyMe ? "既に走査中です。" : "既に走査中です。\n" + formatProgress(data.scan), ephemeral: true });
  const scanDays = interaction.options.getInteger("days");
  const reportLimit = interaction.options.getInteger("limit") ?? 10;
  const channelsValue = interaction.options.getString("channels");
  const excludeBots = interaction.options.getBoolean("exclude_bots") ?? false;
  const excludedChannelsValue = interaction.options.getString("exclude_channels");
  let rootChannelIds;
  try { rootChannelIds = parseChannelIds(channelsValue); } catch (error) {
    return interaction.reply({ content: error.message, ephemeral: true });
  }
  if (rootChannelIds.length && excludedChannelsValue?.trim()) {
    return interaction.reply({ content: "channels と exclude_channels は同時に指定できません。", ephemeral: true });
  }
  const excludedChannelIds = parseExcludedChannelIds(excludedChannelsValue);
  const onlyMe = interaction.options.getBoolean("only_me") ?? false;
  const reportDays = scanDays ?? 30;
  const scopeKey = channelScopeKey(rootChannelIds);
  const resuming = ["running", "failed"].includes(data.scan.status) && data.scan.runId;
  const requestedScan = { reportDays, reportLimit, scanDays, excludeBots, excludedChannelIds, onlyMe, scopeKey, rootChannelIds };
  if (resuming && !scanResumeMatches(data.scan, requestedScan)) {
    return interaction.reply({ content: "失敗した走査を再開するには、days・channels・exclude_bots・exclude_channels・only_me・limitを前回と同じにしてください。", ephemeral: true });
  }
  const cooldown = resuming ? 0 : scanCooldownRemaining(data.scan.finishedAt, Date.now(), scanCooldownMs);
  if (cooldown) return interaction.reply({ content: `次の /scan は約${Math.ceil(cooldown / 60000)}分後に実行できます。`, ephemeral: true });
  const initialScan = resuming ? { ...data.scan, status: "running", requesterId: interaction.user.id } : {
    ...requestedScan, status: "running", phase: "discover", channelIndex: 0, channelTotal: 0,
    channelTotalKnown: false, messageTotalKnown: false, messages: 0, pages: 0, channelCount: 0, threadCount: 0, processedChannels: 0, processedThreads: 0,
    startedAt: new Date().toISOString(), skippedChannels: [], discoveryErrors: [], requesterId: interaction.user.id, channelNames: {}
  };
  await interaction.reply({
    ...intermediatePayload({ ...data, scan: initialScan }),
    allowedMentions: onlyMe ? { parse: [] } : { users: [interaction.user.id] },
    flags: onlyMe ? MessageFlags.Ephemeral | MessageFlags.SuppressNotifications : MessageFlags.SuppressNotifications
  });
  const progressMessage = await interaction.fetchReply();
  if (onlyMe) privateInteractions.set(interaction.guild.id, interaction);
  scanGuild(interaction.guild, progressMessage, { requesterId: interaction.user.id, reportDays, reportLimit, scanDays, excludeBots, excludedChannelIds, onlyMe, scopeKey, rootChannelIds })
    .then(() => postScanResult(interaction.guild, data, progressMessage))
    .catch((error) => postScanResult(interaction.guild, data, progressMessage, error))
    .finally(() => privateInteractions.delete(interaction.guild.id));
});

client.login(token);
