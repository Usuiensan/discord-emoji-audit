import { SOURCE } from "./audit.js";

const customEmojiPattern = /<a?:([A-Za-z0-9_]+):(\d+)>/g;

export function isBotMessage(message, botUserId) {
  return Boolean(botUserId && message?.author?.id === botUserId);
}

export function usageEventsFromMessage(message, date, includeReactions = false, botUserId = null) {
  if (isBotMessage(message, botUserId)) return [];
  const metadata = { messageId: message.id, messageCreatedAt: message.createdAt?.toISOString?.() ?? null };
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

export function contentUsageEventsFromUpdate(oldMessage, newMessage, date, botUserId = null) {
  if (isBotMessage(newMessage, botUserId) || !newMessage?.content) return [];
  const metadata = { messageId: newMessage.id, messageCreatedAt: newMessage.createdAt?.toISOString?.() ?? null };
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

export function reactionUsageEvent(reaction, date, source, botUserId = null) {
  const message = reaction?.message;
  const id = reaction?.emoji?.id;
  if (!message || !id || isBotMessage(message, botUserId)) return null;
  return {
    kind: "emoji", id, name: reaction.emoji.name, messageId: message.id,
    messageCreatedAt: message.createdAt?.toISOString?.() ?? null, date, source, count: 1
  };
}
