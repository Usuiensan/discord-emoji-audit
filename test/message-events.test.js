import test from "node:test";
import assert from "node:assert/strict";
import { SOURCE } from "../src/audit.js";
import { contentUsageEventsFromUpdate, isExcludedChannel, reactionUsageEvent, usageEventsFromMessage } from "../src/message-events.js";

const date = new Date("2026-08-17T00:00:00Z");
const createdAt = { toISOString: () => "2026-08-16T00:00:00.000Z" };

test("Bot自身の履歴・新規メッセージを集計しない", () => {
  const message = {
    id: "bot-message", author: { id: "bot" }, content: "<:unused:1>", createdAt,
    stickers: new Map([["s", { id: "s", name: "sticker" }]]),
    reactions: { cache: new Map([["r", { emoji: { id: "1", name: "unused" }, count: 2 }]]) }
  };
  assert.deepEqual(usageEventsFromMessage(message, date, true, "bot"), []);
  assert.equal(usageEventsFromMessage({ ...message, author: { id: "user" } }, date, true, "bot").length, 3);
});

test("exclude_bots指定時は他のBotの本文・スタンプ・リアクションも除外する", () => {
  const message = {
    id: "other-bot-message", author: { id: "other-bot", bot: true }, content: "<:unused:1>", createdAt,
    stickers: new Map([["s", { id: "s", name: "sticker" }]]),
    reactions: { cache: new Map([["r", { emoji: { id: "1", name: "unused" }, count: 2 }]]) }
  };
  assert.equal(usageEventsFromMessage(message, date, true, "bot").length, 3);
  assert.deepEqual(usageEventsFromMessage(message, date, true, "bot", true), []);
  assert.deepEqual(contentUsageEventsFromUpdate({ content: "" }, message, date, "bot", true), []);
  assert.equal(reactionUsageEvent({ message, emoji: { id: "1", name: "unused" } }, date, SOURCE.REACTION_EXACT, "bot", true), null);
});

test("Bot自身の編集とリアクションを集計しない", () => {
  const oldMessage = { content: "", createdAt };
  const newMessage = { id: "bot-message", author: { id: "bot" }, content: "<:unused:1>", createdAt };
  assert.deepEqual(contentUsageEventsFromUpdate(oldMessage, newMessage, date, "bot"), []);
  assert.equal(contentUsageEventsFromUpdate(oldMessage, { ...newMessage, author: { id: "user" } }, date, "bot").length, 1);
  assert.equal(reactionUsageEvent({ message: newMessage, emoji: { id: "1", name: "unused" } }, date, SOURCE.REACTION_EXACT, "bot"), null);
  assert.equal(reactionUsageEvent({ message: { ...newMessage, author: { id: "user" } }, emoji: { id: "1", name: "unused" } }, date, SOURCE.REACTION_EXACT, "bot").count, 1);
});

test("リアクター自身がBotなら集計しない", () => {
  const reaction = { message: { id: "message", author: { id: "user" }, createdAt }, emoji: { id: "1", name: "unused" } };
  assert.equal(reactionUsageEvent(reaction, date, SOURCE.REACTION_EXACT, "bot", false, { id: "bot", bot: true }), null);
  assert.equal(reactionUsageEvent(reaction, date, SOURCE.REACTION_EXACT, "bot", true, { id: "other-bot", bot: true }), null);
  const humanEvent = reactionUsageEvent(reaction, date, SOURCE.REACTION_EXACT, "bot", false, { id: "user" });
  assert.equal(humanEvent.count, 1);
  assert.equal(humanEvent.reactorIsBot, false);
  assert.equal(usageEventsFromMessage({ id: "message", author: { id: "user" }, createdAt, reactions: { cache: new Map([["r", { emoji: { id: "1", name: "unused" }, count: 1, me: true }]]) } }, date, true, "bot").length, 0);
});

test("編集で追加された絵文字だけを利用として返す", () => {
  const oldMessage = { content: "<:one:1>", createdAt };
  const newMessage = { id: "message", author: { id: "user" }, content: "<:one:1> <:two:2>", createdAt };
  assert.deepEqual(contentUsageEventsFromUpdate(oldMessage, newMessage, date).map(({ id, count }) => ({ id, count })), [{ id: "2", count: 1 }]);
});

test("除外チャンネルはチャンネル自身とそのスレッドに一致する", () => {
  assert.equal(isExcludedChannel({ id: "channel", parentId: null }, ["channel"]), true);
  assert.equal(isExcludedChannel({ id: "thread", parentId: "channel" }, ["channel"]), true);
  assert.equal(isExcludedChannel({ id: "other", parentId: "channel" }, ["thread"]), false);
});
