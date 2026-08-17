import { SlashCommandBuilder } from "discord.js";

export const assetEventNames = [
  "GuildEmojiCreate", "GuildEmojiDelete", "GuildEmojiUpdate",
  "GuildStickerCreate", "GuildStickerDelete", "GuildStickerUpdate"
];

export const commands = [new SlashCommandBuilder()
  .setName("scan")
  .setDescription("絵文字・スタンプの使用状況を調べる")
  .addIntegerOption((option) => option
    .setName("days")
    .setDescription("過去N日だけを再走査（1以上）。省略時は全期間")
    .setMinValue(1)
    .setRequired(false))
  .addIntegerOption((option) => option
    .setName("limit")
    .setDescription("上位・下位を何位まで表示するか（同率はすべて表示）")
    .setMinValue(1)
    .setMaxValue(100)
    .setRequired(false))
  .addStringOption((option) => option
    .setName("channels")
    .setDescription("対象チャンネルID/メンションをカンマ区切り。省略時は全チャンネル")
    .setMaxLength(1000)
    .setRequired(false))
  .addBooleanOption((option) => option
    .setName("exclude_bots")
    .setDescription("Botが送信したメッセージを集計から除外する")
    .setRequired(false))
  .addStringOption((option) => option
    .setName("exclude_channels")
    .setDescription("除外するチャンネルID/メンションをカンマ区切りで指定")
    .setMaxLength(1000)
    .setRequired(false))
  .addBooleanOption((option) => option
    .setName("only_me")
    .setDescription("進捗と結果を自分だけに表示する")
    .setRequired(false))
  .toJSON(), new SlashCommandBuilder()
  .setName("report")
  .setDescription("直近の調査結果を再表示する（スキャンなし）")
  .addStringOption((option) => option
    .setName("channels")
    .setDescription("対象チャンネルID/メンション。省略時は全チャンネル")
    .setMaxLength(1000)
    .setRequired(false))
  .addBooleanOption((option) => option
    .setName("only_me")
    .setDescription("結果を自分だけに表示する")
    .setRequired(false))
  .toJSON()];
