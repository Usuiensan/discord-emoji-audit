import "dotenv/config";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Client, Collection, Events, GatewayIntentBits, MessageFlags, Partials, PermissionsBitField, SlashCommandBuilder } from "discord.js";
import {
  SOURCE, assetKey, cloneData, guildData, loadDatabase, loadScanStage,
  recordUsage, removeScanStage, report, saveDatabase, saveScanStage, syncAssetKind, syncAssets
} from "./audit.js";
import { contentUsageEventsFromUpdate, isBotMessage, reactionUsageEvent, usageEventsFromMessage } from "./message-events.js";
import { formatCompletion, formatProgress } from "./progress.js";

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

const commands = [new SlashCommandBuilder()
  .setName("scan")
  .setDescription("削除をおすすめする絵文字・スタンプを調べる")
  .toJSON()];

function isManager(interaction) {
  return interaction.memberPermissions?.has(PermissionsBitField.Flags.ManageGuild);
}

function assetIsCountable(data, kind, id) {
  const asset = data.assets[assetKey(kind, id)];
  return Boolean(asset && (asset.current || data.lineages[asset.lineageId]?.confirmedAt));
}

function applyUsageEvent(data, event) {
  const asset = data.assets[assetKey(event.kind, event.id)];
  if (!asset || !assetIsCountable(data, event.kind, event.id)) return false;
  return recordUsage(data, event.kind, event.id, event.date, event.source, event.count, { name: event.name });
}

function applyScanEvents(data, scan, events) {
  for (const event of events) {
    if (!applyUsageEvent(data, event)) continue;
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
  const serializable = events.map(({ messageId, ...event }) => event);
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

function applyLiveJournalToStage(guild, data, stage) {
  const offset = data.scan.liveAppliedOffset ?? 0;
  const { events, endOffset } = readLiveEvents(guild.id, offset);
  let deferred = 0;
  for (const event of events) {
    if (!eventIsAfterScanStart(event, data.scan.startedAt)) {
      deferred++;
      continue;
    }
    applyUsageEvent(stage.working, event);
  }
  data.scan.deferredEvents = (data.scan.deferredEvents ?? 0) + deferred;
  data.scan.liveAppliedOffset = endOffset;
  data.scan.pendingLiveEvents = 0;
  if (events.length) data.lastEventAt = new Date().toISOString();
}

function applyLiveJournalToDatabase(guild, data) {
  const offset = data.scan.liveAppliedOffset ?? 0;
  const { events, endOffset } = readLiveEvents(guild.id, offset);
  for (const event of events) {
    if (eventIsAfterScanStart(event, data.scan.startedAt)) applyUsageEvent(data, event);
    else data.scan.deferredEvents = (data.scan.deferredEvents ?? 0) + 1;
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
  if (["running", "failed", "partial"].includes(data.scan.status)) return false;
  applyLiveJournalToDatabase(guild, data);
  compactLiveJournal(guild, data);
  return true;
}

function recordOrQueue(guild, events) {
  if (!events.length) return;
  if (scanLocks.has(guild.id)) {
    const data = guildData(db, guild.id);
    const relevant = events.filter((event) => event.kind === "emoji" || event.kind === "sticker");
    try { if (relevant.length) appendLiveEvents(guild, relevant); } catch (error) {
      data.scan.error = `走査中イベント保存失敗: ${error.message}`;
      console.error(`走査中イベント保存失敗 (${guild.id}): ${error.stack ?? error.message}`);
    }
    return;
  }
  const data = guildData(db, guild.id);
  for (const event of events) applyUsageEvent(data, event);
  data.lastEventAt = new Date().toISOString();
  saveDatabase(dataFile, db);
}

function stagePath(runId, guildId = "") {
  return path.resolve(path.dirname(dataFile), `scan-${guildId}-${runId}.json`);
}

function compactDiscordMessage(text, maxLength = 1900) {
  if (text.length <= maxLength) return text;
  const head = text.slice(0, maxLength - 35);
  return `${head.slice(0, head.lastIndexOf("\n"))}\n…表示上限のため一部省略しました。`;
}

function markdownCode(value) {
  return "`" + String(value ?? "?").replaceAll("`", "'") + "`";
}

function emojiMention(asset) {
  const name = asset.names.at(-1) ?? "emoji";
  return `<${asset.animated ? "a" : ""}:${name}:${asset.id}>`;
}

function reportRows(data, days, limit) {
  return report(data, { days, limit, namePattern });
}

function deleteCandidateRows(data, days, limit) {
  const candidates = reportRows(data, days, 1000).filter(({ category }) => ["ほぼ未使用", "昔の流行", "最近休眠"].includes(category));
  return { all: candidates, visible: candidates.slice(0, limit) };
}

function deleteReason(row) {
  if (row.category === "ほぼ未使用") return `累計${row.stats.all}件`;
  if (row.category === "昔の流行") return `直近90日0件・過去ピーク${row.stats.peakMonthCount}件`;
  return "直近90日0件";
}

function progressRankRows(data) {
  const rows = reportRows(data, 30, 10000);
  const candidates = rows
    .filter(({ category }) => ["ほぼ未使用", "昔の流行", "最近休眠"].includes(category))
    .sort((a, b) => a.recent - b.recent || a.stats.all - b.stats.all);
  return { top: rows.slice(0, 5), worst: candidates.slice(0, 5) };
}

function progressAssetText(row) {
  const { asset, recent, stats } = row;
  const visual = asset.kind === "emoji" ? `${emojiMention(asset)} ` : "";
  return `${visual}${markdownCode(asset.names.at(-1))} — ${recent}件 / 累計${stats.all}件`;
}

function progressRankText(data, stage = null) {
  const snapshot = stage ? { ...stage.working, scan: data.scan } : data;
  const { top, worst } = progressRankRows(snapshot);
  const format = (rows, empty) => rows.length ? rows.map(progressAssetText).join("\n") : empty;
  return [
    "",
    "**現在の使用数上位5（直近30日）**",
    format(top, "まだ集計された利用がありません。"),
    "",
    "**削除候補・使用数下位5**",
    format(worst, "削除候補はありません。")
  ].join("\n");
}

function progressRankEmbeds(data, stage = null) {
  const snapshot = stage ? { ...stage.working, scan: data.scan } : data;
  const { top, worst } = progressRankRows(snapshot);
  return stickerPreviewEmbeds(30, [
    { rows: top, label: "直近30日の使用数上位" },
    { rows: worst, label: "削除候補・使用数下位" }
  ]).slice(0, 10);
}

function stickerPreviewEmbeds(days, sections) {
  const previews = new Map();
  for (const section of sections) {
    section.rows.forEach((row, index) => {
      const { asset, recent, stats } = row;
      if (asset.kind !== "sticker" || !asset.url) return;
      const key = assetKey(asset.kind, asset.id);
      const preview = previews.get(key) ?? { asset, recent, stats, labels: [] };
      preview.labels.push(`${section.label}${section.rows.length > 1 ? `${index + 1}位` : ""}`);
      previews.set(key, preview);
    });
  }
  return [...previews.values()].map(({ asset, recent, stats, labels }) => ({
    title: `スタンプ: ${asset.names.at(-1) ?? "?"}`,
    description: `${labels.join(" / ")}\n直近${days}日: ${recent}件 / 累計: ${stats.all}件`,
    image: { url: asset.url },
    footer: { text: `ID: ${asset.id}` }
  }));
}

function finalStickerPreviewEmbeds(data, days, limit) {
  const rows = reportRows(data, 30, 10000);
  const recentTop = rows.slice(0, 5);
  const recentWorst = [...rows].sort((a, b) => a.recent - b.recent || a.stats.all - b.stats.all).slice(0, 5);
  const allTop = [...rows].sort((a, b) => b.stats.all - a.stats.all || b.recent - a.recent).slice(0, 5);
  const allWorst = [...rows].sort((a, b) => a.stats.all - b.stats.all || a.recent - b.recent).slice(0, 5);
  const candidates = deleteCandidateRows(data, days, limit).visible;
  return stickerPreviewEmbeds(days, [
    { rows: candidates, label: "削除候補" },
    { rows: recentTop, label: "直近30日の使用数上位" },
    { rows: recentWorst, label: "直近30日の使用数下位" },
    { rows: allTop, label: "累計使用数上位" },
    { rows: allWorst, label: "累計使用数下位" }
  ]);
}

function rankingText(data) {
  const rows = reportRows(data, 30, 10000);
  const recentTop = rows.slice(0, 5);
  const recentWorst = [...rows].sort((a, b) => a.recent - b.recent || a.stats.all - b.stats.all).slice(0, 5);
  const allTop = [...rows].sort((a, b) => b.stats.all - a.stats.all || b.recent - a.recent).slice(0, 5);
  const allWorst = [...rows].sort((a, b) => a.stats.all - b.stats.all || a.recent - b.recent).slice(0, 5);
  const format = (items, metric) => items.length
    ? items.map(({ asset, recent, stats }) => `${asset.kind === "emoji" ? `${emojiMention(asset)} ` : ""}${markdownCode(asset.names.at(-1))} — ${metric === "recent" ? recent : stats.all}件`).join("\n")
    : "対象なし";
  return [
    "",
    "**直近30日の使用数上位5**",
    format(recentTop, "recent"),
    "",
    "**直近30日の使用数下位5**",
    format(recentWorst, "recent"),
    "",
    "**累計使用数上位5**",
    format(allTop, "all"),
    "",
    "**累計使用数下位5**",
    format(allWorst, "all")
  ].join("\n");
}

function intermediatePayload(data, stage = null) {
  const scan = data.scan;
  const snapshot = stage ? { ...stage.working, scan } : data;
  return {
    content: intermediateText(data, stage),
    embeds: progressRankEmbeds(snapshot),
  };
}

function intermediateText(data, stage = null) {
  const scan = data.scan;
  const mention = scan.requesterId ? `<@${scan.requesterId}>\n` : "";
  return compactDiscordMessage(`${mention}**削除候補を調査中**\n${formatProgress(scan)}${progressRankText(data, stage)}`);
}

async function updateProgressMessage(guild, data, stage = null, force = false) {
  const scan = data.scan;
  if (!scan.progressChannelId || !scan.progressMessageId) return;
  const now = Date.now();
  if (!force && now - (progressThrottle.get(guild.id) ?? 0) < 5000) return;
  progressThrottle.set(guild.id, now);
  try {
    const channel = guild.channels.cache.get(scan.progressChannelId) ?? await guild.channels.fetch(scan.progressChannelId);
    const message = await channel.messages.fetch(scan.progressMessageId);
    await message.edit({ ...intermediatePayload(data, stage), allowedMentions: { parse: [] } });
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

async function postScanResult(guild, data, progressMessage, error = null) {
  const target = await findProgressMessage(guild, data, progressMessage);
  if (!target?.channel?.send) return;
  const scan = data.scan;
  const mention = scan.requesterId ? `<@${scan.requesterId}>\n` : "";
  const body = error
    ? `${mention}初期スキャンを停止しました。既存の確定済み集計は維持しています。\n${formatProgress(scan)}\n理由: ${error.message}`
    : `${mention}**集計が完了しました。**\n${formatCompletion(scan)}\n\n${deleteRecommendationText(data, scan.reportDays ?? 30, scan.reportLimit ?? 10)}${rankingText(data)}`;
  const embeds = error ? [] : finalStickerPreviewEmbeds(data, scan.reportDays ?? 30, scan.reportLimit ?? 10);
  try {
    const groups = embeds.length ? Array.from({ length: Math.ceil(embeds.length / 10) }, (_, index) => embeds.slice(index * 10, index * 10 + 10)) : [[]];
    for (let index = 0; index < groups.length; index++) await target.channel.send({
      content: index === 0 ? compactDiscordMessage(body) : "**スタンプ画像（続き）**",
      embeds: groups[index],
      allowedMentions: index === 0 && scan.requesterId ? { users: [scan.requesterId] } : { parse: [] },
      flags: MessageFlags.SuppressNotifications
    });
  } catch (sendError) {
    console.error(`スキャン結果通知失敗 (${guild.id}): ${sendError.stack ?? sendError.message}`);
    try {
      await target.message.edit({
        content: compactDiscordMessage(`${body}\n結果通知の新規投稿に失敗したため、このメッセージを残しています。`),
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
    console.warn(`中間報告メッセージ削除失敗 (${guild.id}): ${deleteError.message}`);
    try {
      await target.message.edit({
        content: compactDiscordMessage(`${body}\n中間報告メッセージを削除できなかったため、結果通知が重複しています。`),
        allowedMentions: { parse: [] }
      });
    } catch (editError) {
      console.warn(`中間報告の削除失敗表示も失敗 (${guild.id}): ${editError.message}`);
    }
  }
}

async function collectChannels(guild, scan) {
  const channels = new Collection();
  const fetched = await retryUntilSuccess(() => guild.channels.fetch(), `チャンネル一覧 (${guild.id})`);
  for (const channel of fetched.values()) if (channel?.isTextBased?.() && channel.guild?.id === guild.id) channels.set(channel.id, channel);
  try {
    const active = await retryUntilSuccess(() => guild.channels.fetchActiveThreads(), `アクティブスレッド (${guild.id})`);
    for (const thread of active.threads.values()) channels.set(thread.id, thread);
  } catch (error) {
    if (!isPermanentFetchError(error)) throw error;
    scan.skippedChannels.push(`active_threads: ${error.message}`);
  }
  for (const channel of channels.values()) {
    if (!channel.threads?.fetchArchived) continue;
    for (const type of ["public", "private"]) {
      try {
        const archived = await retryUntilSuccess(() => channel.threads.fetchArchived({ type, fetchAll: true }), `アーカイブ済みスレッド (${channel.id}/${type})`);
        for (const thread of archived.threads.values()) channels.set(thread.id, thread);
      } catch (error) {
        if (!isPermanentFetchError(error)) throw error;
        scan.skippedChannels.push(`${channel.id}:archived_${type}: ${error.message}`);
      }
    }
  }
  scan.channelTotalKnown = true;
  scan.channelCount = [...channels.values()].filter((channel) => !channel.isThread?.()).length;
  scan.threadCount = [...channels.values()].filter((channel) => channel.isThread?.()).length;
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
  while (true) {
    try { return await retry(operation); } catch (error) {
      if (isPermanentFetchError(error)) throw error;
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
  await updateProgressMessage(guild, data, stage, true);
  applyLiveJournalToStage(guild, data, stage);
  data.assets = stage.working.assets;
  data.daily = stage.working.daily;
  data.lineages = stage.working.lineages;
  data.scan.status = status;
  data.scan.finishedAt = new Date().toISOString();
  data.scan.phase = "done";
  saveDatabase(dataFile, db, { backup: true });
  removeScanStage(stage.filePath);
  await updateProgressMessage(guild, data, stage, true);
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
      try { stage = loadScanStage(filePath); } catch (error) { throw new Error(`走査チェックポイントを読み込めません。削除せずバックアップ後に再確認してください: ${error.message}`); }
      if (!stage) throw new Error("走査チェックポイントが見つかりません。削除せずバックアップ後に再確認してください");
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
        reportDays: options.reportDays ?? 30, reportLimit: options.reportLimit ?? 10,
        contentUsages: 0, stickerUsages: 0, reactionUsages: 0,
        progressError: null, deferredEvents: 0, pendingLiveEvents: 0, liveAppliedOffset: 0, channelIds: []
      };
      stage = { version: 1, runId, filePath, working, progress: cloneData(data.scan) };
      saveScanStage(filePath, stage);
      saveDatabase(dataFile, db, { backup: true });
    } else {
      stage.filePath = filePath;
      data.scan = stage.progress;
      data.scan.status = "running";
      data.scan.requesterId = options.requesterId ?? data.scan.requesterId ?? null;
      data.scan.reportDays = options.reportDays ?? data.scan.reportDays ?? 30;
      data.scan.reportLimit = options.reportLimit ?? data.scan.reportLimit ?? 10;
      data.scan.contentUsages ??= 0;
      data.scan.stickerUsages ??= 0;
      data.scan.reactionUsages ??= 0;
      if (progressMessage) {
        data.scan.progressChannelId = progressMessage.channelId;
        data.scan.progressMessageId = progressMessage.id;
      }
    }
    await updateProgressMessage(guild, data, stage, true);
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
        let retryDelay = 10000;
        // ponytail: transient channel errors retry indefinitely; one failed channel blocks completion by design.
        while (!completed) {
          try {
            while (true) {
              const batch = await fetchMessagePage(channel, { limit: 100, ...(before ? { before } : {}) });
              if (!batch.size) break;
              for (const message of batch.values()) {
                if (Date.parse(message.createdAt) <= Date.parse(data.scan.startedAt)) {
                  if (message.content) data.contentAvailable = "observed";
                  applyScanEvents(stage.working, data.scan, usageEventsFromMessage(message, message.createdAt, true, client.user?.id));
                  data.scan.messages++;
                }
              }
              before = batch.last().id;
              data.scan.pages++;
              stage.progress = cloneData(data.scan);
              stage.progress.before = before;
              saveScanStage(filePath, stage);
              if (data.scan.pages % 10 === 0) saveDatabase(dataFile, db);
              await updateProgressMessage(guild, data, stage);
              if (batch.size < 100) break;
            }
            completed = true;
          } catch (error) {
            if (isPermanentFetchError(error)) {
              data.scan.skippedChannels.push(`${channel.id}: ${error.message}`);
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
      await updateProgressMessage(guild, data, stage);
    }
    data.scan.status = data.scan.deferredEvents ? "complete_with_deferred" : "complete";
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
    await updateProgressMessage(guild, data, stage, true);
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
    await updateProgressMessage(guild, data, stage, true);
  }
}

function markEvent(guild) {
  const data = guildData(db, guild.id);
  data.lastEventAt = new Date().toISOString();
  saveDatabase(dataFile, db);
  return data;
}

function deleteRecommendationText(data, days, limit) {
  const candidates = deleteCandidateRows(data, days, limit);
  if (!candidates.all.length) return "**削除推奨候補: 0件**\n使用状況から削除を推奨するものはありません。";
  const rows = candidates.visible.map(({ asset, stats, currentOnly, category, recent }) => [
    `- ${asset.kind === "emoji" ? `${emojiMention(asset)} ` : ""}${markdownCode(asset.names.at(-1))} — **${category}**`,
    `  ${category === "ほぼ未使用" ? "" : `理由: ${deleteReason({ stats, category })} / `}直近${days}日: ${recent}件 / 累計: ${currentOnly.all}件`
  ].join("\n"));
  if (candidates.all.length > candidates.visible.length) rows.push(`（他${candidates.all.length - candidates.visible.length}件は表示上限のため省略）`);
  return [`**削除推奨候補: ${candidates.all.length}件**`, ...rows].join("\n");
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

client.on(Events.GuildEmojisUpdate, (guild, emojis) => {
  const data = markEvent(guild);
  data.assetsAvailable = "confirmed";
  syncAssetKind(data, "emoji", emojis.map((emoji) => ({ id: emoji.id, name: emoji.name, managed: emoji.managed, animated: emoji.animated })));
  saveDatabase(dataFile, db);
});

client.on(Events.GuildStickersUpdate, (guild, stickers) => {
  const data = markEvent(guild);
  data.assetsAvailable = "confirmed";
  syncAssetKind(data, "sticker", stickers.map((sticker) => ({ id: sticker.id, name: sticker.name, url: sticker.url, format: sticker.format })));
  saveDatabase(dataFile, db);
});

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

client.on(Events.MessageReactionAdd, (reaction) => {
  const guild = reaction.message.guild ?? client.guilds.cache.get(reaction.message.guildId);
  if (!guild) return;
  const event = reactionUsageEvent(reaction, new Date(), SOURCE.REACTION_EXACT, client.user?.id);
  if (event) recordOrQueue(guild, [event]);
});

client.on(Events.MessageReactionRemove, (reaction) => {
  const guild = reaction.message.guild ?? client.guilds.cache.get(reaction.message.guildId);
  if (!guild) return;
  const event = reactionUsageEvent(reaction, new Date(), SOURCE.REACTION_REMOVE, client.user?.id);
  if (event) recordOrQueue(guild, [event]);
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand() || interaction.commandName !== "scan") return;
  if (!interaction.guild) return interaction.reply({ content: "サーバー内で実行してください。", ephemeral: true });
  if (!isManager(interaction)) return interaction.reply({ content: "Manage Server権限が必要です。Bot自身に管理者権限は不要です。", ephemeral: true });
  const data = guildData(db, interaction.guild.id);
  if (data.scan.status === "running" && scanLocks.has(interaction.guild.id)) return interaction.reply({ content: "既に走査中です。\n" + formatProgress(data.scan), ephemeral: true });
  const reportDays = 30;
  const reportLimit = 10;
  data.scan.requesterId = interaction.user.id;
  data.scan.reportDays = reportDays;
  data.scan.reportLimit = reportLimit;
  const initialScan = {
    ...data.scan, status: "running", phase: "discover", channelIndex: 0, channelTotal: 0,
    channelTotalKnown: false, messageTotalKnown: false, messages: 0, pages: 0, channelCount: 0, threadCount: 0, processedChannels: 0, processedThreads: 0,
    startedAt: new Date().toISOString(), skippedChannels: [], discoveryErrors: []
  };
  await interaction.reply({
    ...intermediatePayload({ ...data, scan: initialScan }),
    allowedMentions: { users: [interaction.user.id] },
    flags: MessageFlags.SuppressNotifications
  });
  const progressMessage = await interaction.fetchReply();
  scanGuild(interaction.guild, progressMessage, { requesterId: interaction.user.id, reportDays, reportLimit })
    .then(() => postScanResult(interaction.guild, data, progressMessage))
    .catch((error) => postScanResult(interaction.guild, data, progressMessage, error));
});

client.login(token);
