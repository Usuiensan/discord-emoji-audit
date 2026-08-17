import test from "node:test";
import assert from "node:assert/strict";
import { Events } from "discord.js";
import { addApplicationOwners, canRunScan, OPERATOR_USER_ID, parseUserIds, scanCooldownRemaining } from "../src/authorization.js";
import { assetEventNames, commands } from "../src/discord-contract.js";
import { scanConfig, scanResumeMatches } from "../src/scan-config.js";

test("Discord契約のイベント名とslash commandを起動前に検証する", () => {
  for (const eventName of assetEventNames) assert.equal(typeof Events[eventName], "string", `${eventName} must exist`);
  assert.deepEqual(commands.map(({ name }) => name), ["scan", "report"]);
});

test("scanは管理者、Bot所有者、指定運用者だけが実行できる", () => {
  const owners = addApplicationOwners(parseUserIds("owner"), { id: "owner" });
  assert.equal(canRunScan({ userId: OPERATOR_USER_ID, botOwnerIds: owners }), true);
  assert.equal(canRunScan({ userId: "owner", botOwnerIds: owners }), true);
  assert.equal(canRunScan({ userId: "admin", memberPermissions: { has: (permission) => permission === "Administrator" }, botOwnerIds: owners }), true);
  assert.equal(canRunScan({ userId: "member", memberPermissions: { has: () => false }, botOwnerIds: owners }), false);
  assert.equal(scanCooldownRemaining("2026-08-17T00:00:00.000Z", Date.parse("2026-08-17T00:04:00.000Z")), 60000);
});

test("再開時は保存済みの走査条件が完全一致する", () => {
  const saved = scanConfig({ scanDays: 30, excludeBots: true, excludedChannelIds: ["b", "a"], onlyMe: false, reportDays: 30, reportLimit: 10, scopeKey: "all", rootChannelIds: [] });
  assert.equal(scanResumeMatches(saved, { ...saved, excludedChannelIds: ["a", "b"] }), true);
  assert.equal(scanResumeMatches(saved, { ...saved, scanDays: 7 }), false);
});
