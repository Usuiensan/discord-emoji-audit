import { SOURCE } from "./audit.js";

const customEmojiPattern = /<a?:([A-Za-z0-9_]+):(\d+)>/g;

export function isBotMessage(message, botUserId) {
  return Boolean(botUserId && message?.author?.id === botUserId);
}

function isExcludedBotMessage(message, botUserId, excludeBots) {
  return isBotMessage(message, botUserId) || (excludeBots && message?.author?.bot === true);
}

export function isExcludedChannel(channel, excludedChannelIds = []) {
  const ids = excludedChannelIds instanceof Set ? excludedChannelIds : new Set(excludedChannelIds);
  const id = typeof channel === "string" ? channel : channel?.id;
  const parentId = typeof channel === "string" ? null : channel?.parentId;
  return ids.has(id) || ids.has(parentId);
}

function eventMetadata(message) {
  return {
    messageId: message.id,
    messageCreatedAt: message.createdAt?.toISOString?.() ?? null,
    channelId: message.channelId ?? message.channel?.id ?? null,
    parentChannelId: message.channel?.parentId ?? null,
    authorIsBot: message.author?.bot === true
  };
}

export function usageEventsFromMessage(message, date, includeReactions = false, botUserId = null, excludeBots = false) {
  if (isExcludedBotMessage(message, botUserId, excludeBots)) return [];
  const metadata = eventMetadata(message);
  const events = [];
  for (const match of (message.content ?? "").matchAll(customEmojiPattern)) events.push({ ...metadata, kind: "emoji", id: match[2], name: match[1], date, source: SOURCE.CONTENT, count: 1 });
  for (const sticker of message.stickers?.values?.() ?? []) events.push({ ...metadata, kind: "sticker", id: sticker.id, name: sticker.name, date, source: SOURCE.STICKER, count: 1 });
  if (includeReactions) {
    for (const reaction of message.reactions?.cache?.values?.() ?? []) {
      if (reaction.emoji.id) events.push({ ...metadata, kind: "emoji", id: reaction.emoji.id, name: reaction.emoji.name, date, source: SOURCE.REACTION_APPROX, count: reaction.count ?? 0 });
    }
  }
  return events;
}

export function contentUsageEventsFromUpdate(oldMessage, newMessage, date, botUserId = null, excludeBots = false) {
  if (isExcludedBotMessage(newMessage, botUserId, excludeBots) || !newMessage?.content) return [];
  const metadata = eventMetadata(newMessage);
  if (!oldMessage?.content) {
    return [...newMessage.content.matchAll(customEmojiPattern)].map((match) => ({
      ...metadata, kind: "emoji", id: match[2], name: match[1], date, source: SOURCE.CONTENT_UNCERTAIN, count: 1
    }));
  }
  const oldCounts = new Map();
  const events = [];
  for (const match of oldMessage.content.matchAll(customEmojiPattern)) oldCounts.set(match[2], (oldCounts.get(match[2]) ?? 0) + 1);
  for (const match of newMessage.content.matchAll(customEmojiPattern)) {
    const id = match[2];
    const delta = 1 - (oldCounts.get(id) ?? 0);
    if (delta > 0) events.push({ ...metadata, kind: "emoji", id, name: match[1], date, source: SOURCE.CONTENT, count: delta });
    oldCounts.set(id, (oldCounts.get(id) ?? 0) - 1);
  }
  return events;
}

export function reactionUsageEvent(reaction, date, source, botUserId = null, excludeBots = false) {
  const message = reaction?.message;
  const id = reaction?.emoji?.id;
  if (!message || !id || isExcludedBotMessage(message, botUserId, excludeBots)) return null;
  return {
    ...eventMetadata(message), kind: "emoji", id, name: reaction.emoji.name, date, source, count: 1
  };
}
