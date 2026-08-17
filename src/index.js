import "dotenv/config";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Client, Collection, Events, GatewayIntentBits, MessageFlags, Partials, PermissionsBitField, SlashCommandBuilder } from "discord.js";
import {
  SOURCE, assetKey, cloneData, guildData, lineageCandidates, linkAssets, loadDatabase, loadScanStage,
  recordUsage, removeScanStage, report, saveDatabase, saveScanStage, syncAssetKind, syncAssets
} from "./audit.js";
import { formatProgress } from "./progress.js";

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
  .setDescription("絵文字・スタンプ棚卸しを開始")
  .addIntegerOption((option) => option.setName("days").setDescription("中間報告に表示する直近日数").setMinValue(1).setMaxValue(3650))
  .addIntegerOption((option) => option.setName("limit").setDescription("中間報告の表示件数").setMinValue(1).setMaxValue(30))
  .toJSON()];

function isManager(interaction) {
  return interaction.memberPermissions?.has(PermissionsBitField.Flags.ManageGuild);
}

function assetIsCountable(data, kind, id) {
  const asset = data.assets[assetKey(kind, id)];
  return Boolean(asset && (asset.current || data.lineages[asset.lineageId]?.confirmedAt));
}

function usageEventsFromMessage(message, date, includeReactions = false) {
  const events = [];
  const metadata = { messageId: message.id, messageCreatedAt: message.createdAt?.toISOString?.() ?? null };
  const pattern = /<a?:([A-Za-z0-9_]+):(\d+)>/g;
  for (const match of (message.content ?? "").matchAll(pattern)) events.push({ ...metadata, kind: "emoji", id: match[2], name: match[1], date, source: SOURCE.CONTENT, count: 1 });
  for (const sticker of message.stickers?.values?.() ?? []) events.push({ ...metadata, kind: "sticker", id: sticker.id, name: sticker.name, date, source: SOURCE.STICKER, count: 1 });
  if (includeReactions) {
    for (const reaction of message.reactions?.cache?.values?.() ?? []) {
      if (reaction.emoji.id) events.push({ ...metadata, kind: "emoji", id: reaction.emoji.id, name: reaction.emoji.name, date, source: SOURCE.REACTION_APPROX, count: reaction.count ?? 0 });
    }
  }
  return events;
}

function applyUsageEvent(data, event) {
  const asset = data.assets[assetKey(event.kind, event.id)];
  if (!asset || !assetIsCountable(data, event.kind, event.id)) return false;
  return recordUsage(data, event.kind, event.id, event.date, event.source, event.count, { name: event.name });
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

function reportEmbeds(data, days, limit) {
  return reportRows(data, days, limit).filter(({ asset }) => asset.kind === "sticker" && asset.url).slice(0, 10).map(({ asset, stats, currentOnly, category, recent }) => ({
    title: `スタンプ: ${asset.names.at(-1) ?? "?"}`,
    description: `${category}\n直近${days}日: ${recent}件 / 現在ID累計: ${currentOnly.all}件 / 系列累計: ${stats.all}件`,
    image: { url: asset.url },
    footer: { text: `ID: ${asset.id}` }
  }));
}

function intermediatePayload(data, stage = null) {
  const scan = data.scan;
  const snapshot = stage ? { ...stage.working, scan } : data;
  return {
    content: intermediateText(data, stage),
    embeds: reportEmbeds(snapshot, scan.reportDays ?? 30, scan.reportLimit ?? 10)
  };
}

function intermediateText(data, stage = null) {
  const scan = data.scan;
  const snapshot = stage ? { ...stage.working, scan } : data;
  const days = scan.reportDays ?? 30;
  const limit = scan.reportLimit ?? 10;
  const mention = scan.requesterId ? `<@${scan.requesterId}>\n` : "";
  return compactDiscordMessage(`${mention}${formatProgress(scan)}\n\n中間棚卸し（過去${days}日）\n${reportText(snapshot, days, limit)}`);
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
    : `${mention}${scan.status === "partial" ? "初期スキャンは部分完了しました。" : "初期スキャンが完了しました。"}\n${formatProgress(scan)}\n\n${reportText(data, scan.reportDays ?? 30, scan.reportLimit ?? 10)}`;
  const resultPayload = error
    ? { content: compactDiscordMessage(body), embeds: [] }
    : { content: compactDiscordMessage(body), embeds: reportEmbeds(data, scan.reportDays ?? 30, scan.reportLimit ?? 10) };
  try {
    await target.channel.send({
      ...resultPayload,
      allowedMentions: scan.requesterId ? { users: [scan.requesterId] } : { parse: [] },
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
  const fetched = await retry(() => guild.channels.fetch());
  for (const channel of fetched.values()) if (channel?.isTextBased?.() && channel.guild?.id === guild.id) channels.set(channel.id, channel);
  try {
    const active = await retry(() => guild.channels.fetchActiveThreads());
    for (const thread of active.threads.values()) channels.set(thread.id, thread);
  } catch (error) {
    scan.discoveryErrors.push(`active_threads: ${error.message}`);
  }
  for (const channel of channels.values()) {
    if (!channel.threads?.fetchArchived) continue;
    try {
      for (const type of ["public", "private"]) {
        const archived = await retry(() => channel.threads.fetchArchived({ type, fetchAll: true }));
        for (const thread of archived.threads.values()) channels.set(thread.id, thread);
      }
    } catch (error) {
      scan.discoveryErrors.push(`${channel.id}:archived_threads: ${error.message}`);
    }
  }
  scan.channelTotalKnown = scan.discoveryErrors.length === 0;
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
      let orphanError = null;
      if (fs.existsSync(liveJournalPath(guild.id))) {
        const orphanPath = `${liveJournalPath(guild.id)}.${data.scan.runId ?? Date.now()}.orphan`;
        fs.renameSync(liveJournalPath(guild.id), orphanPath);
        orphanError = `前回の未反映イベントログを保管しました: ${orphanPath}`;
      }
      data.scan = {
        status: "running", runId, startedAt: new Date().toISOString(), finishedAt: null, phase: "discover",
        messages: 0, pages: 0, channelIndex: 0, channelTotal: 0, channelTotalKnown: false, messageTotalKnown: false, channelCount: 0, threadCount: 0,
        processedChannels: 0, processedThreads: 0, currentChannelId: null, currentChannelName: null,
        skippedChannels: [], discoveryErrors: [], progressChannelId: progressMessage?.channelId ?? null,
        progressMessageId: progressMessage?.id ?? null, requesterId: options.requesterId ?? null,
        reportDays: options.reportDays ?? 30, reportLimit: options.reportLimit ?? 10,
        progressError: null, deferredEvents: 0, pendingLiveEvents: 0, liveAppliedOffset: 0, channelIds: []
      };
      data.scan.error = orphanError;
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
        data.scan.channelIndex = index + 1;
        data.scan.currentChannelId = null;
        data.scan.currentChannelName = null;
        stage.progress = cloneData(data.scan);
        stage.progress.channelIds = channelIds;
        if (channel?.isThread?.()) data.scan.processedThreads++;
        else data.scan.processedChannels++;
        stage.progress.processedChannels = data.scan.processedChannels;
        stage.progress.processedThreads = data.scan.processedThreads;
        saveScanStage(filePath, stage);
        saveDatabase(dataFile, db);
        await updateProgressMessage(guild, data, stage);
        continue;
      }
      let before = stage.progress.before ?? null;
      try {
        while (true) {
          const batch = await fetchMessagePage(channel, { limit: 100, ...(before ? { before } : {}) });
          if (!batch.size) break;
          for (const message of batch.values()) {
            if (Date.parse(message.createdAt) <= Date.parse(data.scan.startedAt)) {
              if (message.content) data.contentAvailable = "observed";
              for (const event of usageEventsFromMessage(message, message.createdAt, true)) applyUsageEvent(stage.working, event);
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
      } catch (error) {
        data.scan.skippedChannels.push(`${channel.id}: ${error.message}`);
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
    data.scan.status = data.scan.skippedChannels.length || data.scan.discoveryErrors.length
      ? "partial"
      : data.scan.deferredEvents ? "complete_with_deferred" : "complete";
    data.scan.phase = "done";
    stage.progress = cloneData(data.scan);
    saveScanStage(filePath, stage);
    if (data.scan.status === "partial") {
      data.scan.pendingLiveEvents = countPendingLiveEvents(guild, data);
      saveDatabase(dataFile, db);
      await updateProgressMessage(guild, data, stage, true);
      return;
    }
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
    if (data.scan.status === "partial" || data.scan.status === "failed") {
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

function reportText(data, days, limit) {
  const rows = reportRows(data, days, limit);
  const code = (value) => `\`${String(value ?? "?").replaceAll("`", "'")}\``;
  const lines = [
    `**対象**: 現在登録中のみ / 資産一覧: ${data.assetsAvailable ?? "unknown"} / 集計期間: 直近${days}日 / UTC日付`,
    `**走査状態**: ${data.scan.status} / 取得失敗: ${(data.scan.skippedChannels?.length ?? 0) + (data.scan.discoveryErrors?.length ?? 0)}件 / 保留イベント: ${data.scan.pendingLiveEvents ?? 0}件 / 未反映境界: ${data.scan.deferredEvents ?? 0}件`,
    "**分類基準**: 最近の流行=直近30日10件以上、昔の流行=直近90日0件かつピーク月10件以上、休眠=直近90日0件、定番=直近90日10件以上かつ活動月3か月以上",
    ...rows.map(({ asset, stats, currentOnly, category, recent, naming }) => {
      const kind = asset.kind === "emoji" ? "絵文字" : "スタンプ";
      const names = (asset.nameHistory ?? asset.names.map((name) => ({ name }))).map((entry) => `${entry.name}${entry.observedAt ? `@${entry.observedAt.slice(0, 10)}` : ""}`).join(", ");
      const currentMonths = Object.entries(currentOnly.byMonth).sort(([a], [b]) => a.localeCompare(b)).map(([month, count]) => `${month}:${count}`).join(" ") || "なし";
      const lineageMonths = Object.entries(stats.byMonth).sort(([a], [b]) => a.localeCompare(b)).map(([month, count]) => `${month}:${count}`).join(" ") || "なし";
      const notes = [
        stats.exactReactions ? `正確reaction ${stats.exactReactions}件` : "",
        stats.approximateReactions ? `近似reaction ${stats.approximateReactions}件` : "",
        stats.removedReactions ? `解除観測 ${stats.removedReactions}件` : "",
        stats.uncertainContent ? `編集差分不明 ${stats.uncertainContent}件` : ""
      ].filter(Boolean).join(" / ");
      return [
        `- **${kind}** ${asset.kind === "emoji" ? `${emojiMention(asset)} ` : "🖼️ "}${markdownCode(asset.names.at(-1))} — **${category}**`,
        `  ID: ${markdownCode(asset.id)} / 直近${days}日: ${recent}件 / 現在ID累計: ${currentOnly.all}件 / 系列累計: ${stats.all}件`,
        `  30日: ${stats.recent30}件 / 90日: ${stats.recent90}件 / 365日: ${stats.recent365}件 / 最終利用: ${stats.lastUse ?? "なし"}`,
        `  ピーク: ${stats.peakMonth ? `${stats.peakMonth}（${stats.peakMonthCount}件）` : "なし"} / 命名: ${naming.ok ? "OK" : "要確認"}`,
        `  名前履歴: ${names || "なし"} / 月別現在ID: ${currentMonths} / 月別系列: ${lineageMonths}${notes ? ` / ${notes}` : ""}`
      ].join("\n");
    }),
    rows.length ? "" : "現在登録中の対象がありません。"
  ];
  return lines.join("\n");
}

function splitMessage(text, maxLength = 1900) {
  const chunks = [];
  let current = "";
  for (const line of text.split("\n")) {
    if (line.length > maxLength) {
      if (current) chunks.push(current);
      for (let index = 0; index < line.length; index += maxLength) chunks.push(line.slice(index, index + maxLength));
      current = "";
      continue;
    }
    if (current && current.length + line.length + 1 > maxLength) {
      chunks.push(current);
      current = "";
    }
    current += `${current ? "\n" : ""}${line}`;
  }
  if (current) chunks.push(current);
  return chunks.length ? chunks : ["(空)"];
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
  if (!message.guild) return;
  const data = guildData(db, message.guild.id);
  if (message.content) data.contentAvailable = "observed";
  recordOrQueue(message.guild, usageEventsFromMessage(message, new Date()));
});

client.on(Events.MessageUpdate, (oldMessage, newMessage) => {
  if (!newMessage.guild || !newMessage.content) return;
  const data = guildData(db, newMessage.guild.id);
  data.contentAvailable = "observed";
  if (!oldMessage.content) {
    const uncertain = [];
    for (const match of newMessage.content.matchAll(/<a?:([A-Za-z0-9_]+):(\d+)>/g)) {
      uncertain.push({ kind: "emoji", id: match[2], name: match[1], messageId: newMessage.id, messageCreatedAt: newMessage.createdAt?.toISOString?.() ?? null, date: new Date(), source: SOURCE.CONTENT_UNCERTAIN, count: 1 });
    }
    recordOrQueue(newMessage.guild, uncertain);
    return;
  }
  const oldCounts = new Map();
  const events = [];
  for (const match of oldMessage.content.matchAll(/<a?:([A-Za-z0-9_]+):(\d+)>/g)) oldCounts.set(match[2], (oldCounts.get(match[2]) ?? 0) + 1);
  for (const match of newMessage.content.matchAll(/<a?:([A-Za-z0-9_]+):(\d+)>/g)) {
    const id = match[2];
    const delta = 1 - (oldCounts.get(id) ?? 0);
    if (delta > 0) events.push({ kind: "emoji", id, name: match[1], messageId: newMessage.id, messageCreatedAt: newMessage.createdAt?.toISOString?.() ?? null, date: new Date(), source: SOURCE.CONTENT, count: delta });
    oldCounts.set(id, (oldCounts.get(id) ?? 0) - 1);
  }
  recordOrQueue(newMessage.guild, events);
});

client.on(Events.MessageReactionAdd, (reaction) => {
  const guild = reaction.message.guild ?? client.guilds.cache.get(reaction.message.guildId);
  if (!guild) return;
  const id = reaction.emoji.id;
  if (id) recordOrQueue(guild, [{ kind: "emoji", id, name: reaction.emoji.name, messageId: reaction.message.id, messageCreatedAt: reaction.message.createdAt?.toISOString?.() ?? null, date: new Date(), source: SOURCE.REACTION_EXACT, count: 1 }]);
});

client.on(Events.MessageReactionRemove, (reaction) => {
  const guild = reaction.message.guild ?? client.guilds.cache.get(reaction.message.guildId);
  if (!guild || !reaction.emoji.id) return;
  recordOrQueue(guild, [{ kind: "emoji", id: reaction.emoji.id, name: reaction.emoji.name, messageId: reaction.message.id, messageCreatedAt: reaction.message.createdAt?.toISOString?.() ?? null, date: new Date(), source: SOURCE.REACTION_REMOVE, count: 1 }]);
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand() || interaction.commandName !== "scan") return;
  if (!interaction.guild) return interaction.reply({ content: "サーバー内で実行してください。", ephemeral: true });
  if (!isManager(interaction)) return interaction.reply({ content: "Manage Server権限が必要です。Bot自身に管理者権限は不要です。", ephemeral: true });
  const data = guildData(db, interaction.guild.id);
  const action = null;
  if (action === "status") {
    const current = Object.values(data.assets).filter((asset) => asset.current).length;
    return interaction.reply({ content: `${formatProgress(data.scan)}\n本文取得: ${data.contentAvailable}\n現在資産確認: ${data.assetsAvailable ?? "unknown"}\n現在資産: ${current}\n最終イベント: ${data.lastEventAt ?? "なし"}`, ephemeral: true });
  }
  if (action === "report") {
    const days = interaction.options.getInteger("days") ?? 90;
    const limit = interaction.options.getInteger("limit") ?? 30;
    const chunks = splitMessage(reportText(data, days, limit));
    await interaction.reply({ content: chunks.shift(), embeds: reportEmbeds(data, days, limit), ephemeral: true });
    for (const chunk of chunks) await interaction.followUp({ content: chunk, ephemeral: true });
    return;
  }
  if (action === "candidates") {
    const candidates = lineageCandidates(data);
    const text = candidates.length
      ? candidates.map((candidate) => `${candidate.kind} ${candidate.oldId} (${candidate.oldNames.join(",")}) -> ${candidate.currentId} (${candidate.currentName}) [未確認]`).join("\n")
      : "名前履歴が一致する候補はありません。自動推測はしていません。";
    return interaction.reply({ content: `候補は同一性の確定ではありません。\n${text}`.slice(0, 1900), ephemeral: true });
  }
  if (action === "link") {
    if (data.scan.status === "running") return interaction.reply({ content: "走査中は系列の変更を受け付けません。走査完了後に実行してください。", ephemeral: true });
    const kind = interaction.options.getString("kind", true);
    const oldId = interaction.options.getString("old_id", true);
    const currentId = interaction.options.getString("current_id", true);
    if (oldId === currentId || !data.assets[assetKey(kind, currentId)]?.current || data.assets[assetKey(kind, oldId)]?.current) return interaction.reply({ content: "current_id は現在登録中、old_id は現在未登録のIDを指定してください。両者を同じIDにはできません。", ephemeral: true });
    linkAssets(data, kind, oldId, currentId, interaction.user.id, interaction.options.getString("note") ?? "");
    saveDatabase(dataFile, db);
    return interaction.reply({ content: "確認済みの同一系列として記録しました。旧IDの履歴を取り込むには /audit scan を再実行してください。", ephemeral: true });
  }
  if (action === "scan-accept") {
    if (data.scan.status !== "partial" || !data.scan.runId) return interaction.reply({ content: "反映できる部分走査結果がありません。", ephemeral: true });
    if (scanLocks.has(interaction.guild.id)) return interaction.reply({ content: "既に別の走査処理が動いています。", ephemeral: true });
    const filePath = stagePath(data.scan.runId, interaction.guild.id);
    let stage;
    try { stage = loadScanStage(filePath); } catch (error) { return interaction.reply({ content: `部分走査データを読み込めません。再走査してください。理由: ${error.message}`, ephemeral: true }); }
    if (!stage) return interaction.reply({ content: "部分走査の一時データが見つかりません。再走査してください。", ephemeral: true });
    scanLocks.add(interaction.guild.id);
    try {
      await interaction.reply({ content: "部分走査結果を反映しています。", ephemeral: true });
    } catch (error) {
      scanLocks.delete(interaction.guild.id);
      console.error(`scan-accept開始通知失敗 (${interaction.guild.id}): ${error.stack ?? error.message}`);
      return;
    }
    let committed = false;
    try {
      await commitScan(interaction.guild, data, { ...stage, filePath }, "partial_accepted");
      committed = true;
      applyLiveJournalToDatabase(interaction.guild, data);
      saveDatabase(dataFile, db);
      compactLiveJournal(interaction.guild, data);
      saveDatabase(dataFile, db);
      try { await interaction.editReply({ content: "部分走査結果を反映しました。取得できなかった範囲は未集計のままです。" }); } catch (error) { console.warn(`scan-accept結果通知失敗: ${error.message}`); }
    } catch (error) {
      if (!committed) {
        data.scan.liveAppliedOffset = stage.progress.liveAppliedOffset ?? 0;
        data.scan.deferredEvents = stage.progress.deferredEvents ?? 0;
        data.scan.status = "failed";
        data.scan.error = error.message;
        saveDatabase(dataFile, db);
      }
      const message = committed
        ? `部分走査結果は反映済みですが、後処理に失敗しました。/audit status を確認してください。理由: ${error.message}`
        : `部分走査結果を反映できませんでした。既存集計は維持しています。理由: ${error.message}`;
      try { await interaction.editReply({ content: message }); } catch (editError) { console.warn(`scan-acceptエラー通知失敗: ${editError.message}`); }
    } finally {
      scanLocks.delete(interaction.guild.id);
      await updateProgressMessage(interaction.guild, data, stage, true);
    }
    return;
  }
  if (data.scan.status === "running" && scanLocks.has(interaction.guild.id)) return interaction.reply({ content: "既に走査中です。\n" + formatProgress(data.scan), ephemeral: true });
  const reportDays = interaction.options.getInteger("days") ?? 30;
  const reportLimit = interaction.options.getInteger("limit") ?? 10;
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
