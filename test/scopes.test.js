import test from "node:test";
import assert from "node:assert/strict";
import { channelMatchesScope, channelScopeKey, parseChannelIds } from "../src/scopes.js";

test("チャンネル指定はID・メンションを重複除去して正規化する", () => {
  assert.deepEqual(parseChannelIds("<#20>, 10, <#20>"), ["10", "20"]);
  assert.throws(() => parseChannelIds("not-a-channel"), /チャンネル指定が不正/);
  assert.equal(channelScopeKey(["20", "10", "20"]), "channels:10,20");
  assert.equal(channelScopeKey([]), "all");
});

test("指定チャンネルは本体と配下スレッドだけを対象にする", () => {
  assert.equal(channelMatchesScope({ id: "channel", parentId: null }, ["channel"]), true);
  assert.equal(channelMatchesScope({ id: "thread", parentId: "channel" }, ["channel"]), true);
  assert.equal(channelMatchesScope({ id: "other", parentId: null }, ["channel"]), false);
});
