import "dotenv/config";
import path from "node:path";
import { Client, Collection, Events, GatewayIntentBits, Partials, PermissionsBitField, SlashCommandBuilder } from "discord.js";
import {
  SOURCE, assetKey, guildData, lineageCandidates, linkAssets, loadDatabase, recordUsage, report,
  saveDatabase, syncAssets
} from "./audit.js";

const token = process.env.DISCORD_TOKEN;
const dataFile = path.resolve(process.env.DATA_DIR ?? "./data", "audit.json");
const namePattern = process.env.EMOJI_NAME_PATTERN ?? "^[a-z0-9_]+$";
if (!token) throw new Error("DISCORD_TOKEN が必要です。.env.example を参照してください。");

const db = loadDatabase(dataFile);
const client = new Client({ partials: [Partials.Message, Partials.Channel, Partials.Reaction], intents: [
  GatewayIntentBits.Guilds,
  GatewayIntentBits.GuildMessages,
  GatewayIntentBits.GuildMessageReactions,
  GatewayIntentBits.MessageContent
] });
const scanLocks = new Set();
const pendingUsage = new Map();

const commands = [new SlashCommandBuilder()
  .setName("audit")
  .setDescription("絵文字・スタンプ棚卸し")
  .addSubcommand((sub) => sub.setName("status").setDescription("収集状態を表示"))
  .addSubcommand((sub) => sub.setName("report").setDescription("現在の絵文字・スタンプを分類表示")
    .addIntegerOption((option) => option.setName("days").setDescription("表示する直近日数").setMinValue(1).setMaxValue(3650))
    .addIntegerOption((option) => option.setName("limit").setDescription("表示件数").setMinValue(1).setMaxValue(100)))
  .addSubcommand((sub) => sub.setName("candidates").setDescription("未確認の旧ID→現ID候補を表示"))
  .addSubcommand((sub) => sub.setName("scan").setDescription("現存資産を母集団にして履歴を再走査"))
  .addSubcommand((sub) => sub.setName("link").setDescription("管理者が確認した旧IDと現IDを同一系列にする")
    .addStringOption((option) => option.setName("kind").setDescription("emoji または sticker").setRequired(true)
      .addChoices({ name: "emoji", value: "emoji" }, { name: "sticker", value: "sticker" }))
    .addStringOption((option) => option.setName("old_id").setDescription("旧ID").setRequired(true))
    .addStringOption((option) => option.setName("current_id").setDescription("現在ID").setRequired(true))
    .addStringOption((option) => option.setName("note").setDescription("確認メモ")))
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
  const pattern = /<a?:([A-Za-z0-9_]+):(\d+)>/g;
  for (const match of (message.content ?? "").matchAll(pattern)) events.push({ kind: "emoji", id: match[2], name: match[1], date, source: SOURCE.CONTENT, count: 1 });
  for (const sticker of message.stickers?.values?.() ?? []) events.push({ kind: "sticker", id: sticker.id, name: sticker.name, date, source: SOURCE.STICKER, count: 1 });
  if (includeReactions) {
    for (const reaction of message.reactions?.cache?.values?.() ?? []) {
      if (reaction.emoji.id) events.push({ kind: "emoji", id: reaction.emoji.id, name: reaction.emoji.name, date, source: SOURCE.REACTION_APPROX, count: reaction.count ?? 0 });
    }
  }
  return events;
}

function applyUsageEvent(data, event) {
  const asset = data.assets[assetKey(event.kind, event.id)];
  if (!asset || !assetIsCountable(data, event.kind, event.id)) return;
  recordUsage(data, event.kind, event.id, event.date, event.source, event.count, { name: event.name });
}

function recordOrQueue(guild, events) {
  if (!events.length) return;
  if (scanLocks.has(guild.id)) {
    if (!pendingUsage.has(guild.id)) pendingUsage.set(guild.id, []);
    pendingUsage.get(guild.id).push(...events);
    return;
  }
  const data = guildData(db, guild.id);
  for (const event of events) applyUsageEvent(data, event);
  data.lastEventAt = new Date().toISOString();
  saveDatabase(dataFile, db);
}

function flushPending(guild) {
  const events = pendingUsage.get(guild.id) ?? [];
  pendingUsage.delete(guild.id);
  const data = guildData(db, guild.id);
  for (const event of events) applyUsageEvent(data, event);
  if (events.length) data.lastEventAt = new Date().toISOString();
}

async function collectChannels(guild) {
  const channels = new Collection();
  const fetched = await guild.channels.fetch();
  for (const channel of fetched.values()) if (channel?.isTextBased?.() && channel.guild?.id === guild.id) channels.set(channel.id, channel);
  try {
    const active = await guild.channels.fetchActiveThreads();
    for (const thread of active.threads.values()) channels.set(thread.id, thread);
  } catch (error) {
    console.warn(`active threads取得失敗: ${error.message}`);
  }
  for (const channel of channels.values()) {
    if (!channel.threads?.fetchArchived) continue;
    try {
      for (const type of ["public", "private"]) {
        const archived = await channel.threads.fetchArchived({ type, fetchAll: true });
        for (const thread of archived.threads.values()) channels.set(thread.id, thread);
      }
    } catch {
      // 権限不足や、アーカイブ取得に対応しないチャンネルは欠損として後で表示する。
    }
  }
  return channels;
}

async function scanGuild(guild) {
  if (scanLocks.has(guild.id)) throw new Error("このサーバーは既に走査中です");
  scanLocks.add(guild.id);
  const data = guildData(db, guild.id);
  data.scan = { status: "running", startedAt: new Date().toISOString(), finishedAt: null, messages: 0, skippedChannels: [] };
  data.daily = {};
  try {
    const assets = await fetchCurrentAssets(guild);
    if (!assets) throw new Error("現在の絵文字・スタンプ一覧を完全には取得できませんでした");
    syncAssets(data, assets);
    saveDatabase(dataFile, db);
    const channels = await collectChannels(guild);
    for (const channel of channels.values()) {
      if (!channel.messages?.fetch) continue;
      try {
        let before;
        while (true) {
          const batch = await channel.messages.fetch({ limit: 100, ...(before ? { before } : {}) });
          if (!batch.size) break;
          for (const message of batch.values()) {
            for (const event of usageEventsFromMessage(message, message.createdAt, true)) applyUsageEvent(data, event);
            data.scan.messages++;
          }
          before = batch.last().id;
          if (batch.size < 100) break;
          if (data.scan.messages % 500 === 0) saveDatabase(dataFile, db);
        }
      } catch (error) {
        data.scan.skippedChannels.push(`${channel.id}: ${error.message}`);
      }
    }
    data.scan.status = "complete";
    data.scan.finishedAt = new Date().toISOString();
    data.contentAvailable = true;
  } catch (error) {
    data.scan.status = "failed";
    data.scan.finishedAt = new Date().toISOString();
    throw error;
  } finally {
    scanLocks.delete(guild.id);
    flushPending(guild);
    saveDatabase(dataFile, db);
  }
}

function markEvent(guild) {
  const data = guildData(db, guild.id);
  data.lastEventAt = new Date().toISOString();
  saveDatabase(dataFile, db);
  return data;
}

function reportText(data, days, limit) {
  const rows = report(data, { days, limit, namePattern });
  const lines = [
    `対象: 現在登録中のみ / 直近${days}日順 / UTC日付`,
    "分類基準: 直近30日>=10かつ直近90日の半分以上=最近の流行、直近90日0かつピーク月>=10=昔の流行、直近90日0=最近休眠、直近90日>=10かつ活動月>=3=定番",
    ...rows.map(({ asset, stats, currentOnly, category, recent, naming }) => `${asset.kind === "emoji" ? "絵" : "ス"} ${asset.names.at(-1) ?? "?"} (${asset.id}) [${category}] 現在ID:${recent}件/${days}日・累計${currentOnly.all} / 系列込み累計${stats.all}・30日${stats.recent30} ピーク${stats.peakMonth ?? "-"}:${stats.peakMonthCount} ${naming.ok ? "命名OK" : "命名要確認"}${stats.approximateReactions ? ` 近似reaction${stats.approximateReactions}` : ""}`),
    rows.length ? "" : "現在登録中の対象がありません。"
  ];
  return lines.join("\n");
}

function splitMessage(text, maxLength = 1900) {
  const chunks = [];
  let current = "";
  for (const line of text.split("\n")) {
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
    ...stickers.values().map((sticker) => ({ kind: "sticker", id: sticker.id, name: sticker.name }))
  ];
}

client.once(Events.ClientReady, async (readyClient) => {
  console.log(`ログイン: ${readyClient.user.tag}`);
  for (const guild of readyClient.guilds.cache.values()) {
    await readyClient.application.commands.set(commands, guild.id);
    const data = guildData(db, guild.id);
    const assets = await fetchCurrentAssets(guild);
    if (assets) syncAssets(data, assets);
  }
  saveDatabase(dataFile, db);
});

client.on(Events.GuildCreate, async (guild) => {
  await guild.commands.set(commands);
  const data = guildData(db, guild.id);
  const assets = await fetchCurrentAssets(guild);
  if (assets) syncAssets(data, assets);
  saveDatabase(dataFile, db);
});

client.on(Events.GuildEmojisUpdate, (guild, emojis) => {
  const data = markEvent(guild);
  syncAssets(data, emojis.map((emoji) => ({ kind: "emoji", id: emoji.id, name: emoji.name, managed: emoji.managed, animated: emoji.animated })));
  saveDatabase(dataFile, db);
});

client.on(Events.GuildStickersUpdate, (guild, stickers) => {
  const data = markEvent(guild);
  syncAssets(data, stickers.map((sticker) => ({ kind: "sticker", id: sticker.id, name: sticker.name })));
  saveDatabase(dataFile, db);
});

client.on(Events.MessageCreate, (message) => {
  if (!message.guild) return;
  recordOrQueue(message.guild, usageEventsFromMessage(message, new Date()));
});

client.on(Events.MessageUpdate, (oldMessage, newMessage) => {
  if (!newMessage.guild || !oldMessage.content || !newMessage.content) return;
  const oldCounts = new Map();
  const events = [];
  for (const match of oldMessage.content.matchAll(/<a?:([A-Za-z0-9_]+):(\d+)>/g)) oldCounts.set(match[2], (oldCounts.get(match[2]) ?? 0) + 1);
  for (const match of newMessage.content.matchAll(/<a?:([A-Za-z0-9_]+):(\d+)>/g)) {
    const id = match[2];
    const delta = 1 - (oldCounts.get(id) ?? 0);
    if (delta > 0) events.push({ kind: "emoji", id, name: match[1], date: new Date(), source: SOURCE.CONTENT, count: delta });
    oldCounts.set(id, (oldCounts.get(id) ?? 0) - 1);
  }
  recordOrQueue(newMessage.guild, events);
});

client.on(Events.MessageReactionAdd, (reaction) => {
  const guild = reaction.message.guild ?? client.guilds.cache.get(reaction.message.guildId);
  if (!guild) return;
  const id = reaction.emoji.id;
  if (id) recordOrQueue(guild, [{ kind: "emoji", id, name: reaction.emoji.name, date: new Date(), source: SOURCE.REACTION_EXACT, count: 1 }]);
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand() || interaction.commandName !== "audit") return;
  if (!interaction.guild) return interaction.reply({ content: "サーバー内で実行してください。", ephemeral: true });
  if (!isManager(interaction)) return interaction.reply({ content: "Manage Server権限が必要です。Bot自身に管理者権限は不要です。", ephemeral: true });
  const data = guildData(db, interaction.guild.id);
  const action = interaction.options.getSubcommand();
  if (action === "status") {
    const current = Object.values(data.assets).filter((asset) => asset.current).length;
    return interaction.reply({ content: `走査: ${data.scan.status} / メッセージ: ${data.scan.messages} / 現在資産: ${current} / 取得失敗: ${data.scan.skippedChannels.length} / 最終イベント: ${data.lastEventAt ?? "なし"} / 近似reactionは投稿日時帰属です。`, ephemeral: true });
  }
  if (action === "report") {
    const days = interaction.options.getInteger("days") ?? 90;
    const limit = interaction.options.getInteger("limit") ?? 30;
    const chunks = splitMessage(reportText(data, days, limit));
    await interaction.reply({ content: chunks.shift(), ephemeral: true });
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
    const kind = interaction.options.getString("kind", true);
    const oldId = interaction.options.getString("old_id", true);
    const currentId = interaction.options.getString("current_id", true);
    if (oldId === currentId || !data.assets[assetKey(kind, currentId)]?.current) return interaction.reply({ content: "current_id は現在登録中の正しいIDを指定してください。old_id と同じIDは指定できません。", ephemeral: true });
    linkAssets(data, kind, oldId, currentId, interaction.user.id, interaction.options.getString("note") ?? "");
    saveDatabase(dataFile, db);
    return interaction.reply({ content: "確認済みの同一系列として記録しました。旧IDの履歴を取り込むには /audit scan を再実行してください。", ephemeral: true });
  }
  await interaction.reply({ content: "走査を開始しました。完了後に /audit status と /audit report を確認してください。", ephemeral: true });
  scanGuild(interaction.guild).catch((error) => console.error(`走査失敗 (${interaction.guild.id}): ${error.stack ?? error.message}`));
});

client.login(token);
