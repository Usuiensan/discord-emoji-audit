import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";
import { emptyDatabase, guildData, syncAssets } from "../src/audit.js";
import { archiveCandidates, archiveUrls, buildArchivePage, createArchiveStore, mergeArchiveCatalog, observeArchiveEvents, syncArchiveGuildAssets } from "../src/archive.js";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL9YQAAAABJRU5ErkJggg==", "base64");

test("現存・旧自サーバー・履歴のみのIDを分離し、外部のアニメーション情報を保持する", () => {
  const data = guildData(emptyDatabase(), "123");
  syncAssets(data, [{ kind: "emoji", id: "100", name: "here" }, { kind: "sticker", id: "200", name: "wave", format: 2 }]);
  syncAssets(data, [{ kind: "emoji", id: "100", name: "here" }]);
  observeArchiveEvents(data, [
    { kind: "emoji", id: "300", name: "elsewhere", animated: true, date: new Date("2026-01-01T00:00:00Z") },
    { kind: "sticker", id: "400", name: "moving", formatType: 3 },
    { kind: "emoji", id: "../../escape", name: "bad" }
  ]);
  const current = archiveCandidates(data, "current");
  assert.deepEqual(current.map(({ id }) => id), ["100"]);
  assert.deepEqual(archiveCandidates(data, "history").map(({ id }) => id), ["200", "300", "400"]);
  assert.equal(data.archiveCatalog["emoji:300"].animated, true);
  assert.equal(data.archiveCatalog["sticker:400"].formatType, 3);
  assert.equal(data.daily && Object.keys(data.daily).length, 0);
  const stage = { archiveCatalog: {} };
  mergeArchiveCatalog(stage, data);
  assert.deepEqual(stage.archiveCatalog, data.archiveCatalog);
});

test("棚卸し対象外のmanaged絵文字もアーカイブし、削除後は旧登録扱いにする", () => {
  const data = guildData(emptyDatabase(), "123");
  const managed = { kind: "emoji", id: "500", name: "managed", managed: true, animated: true };
  syncAssets(data, [managed]);
  syncArchiveGuildAssets(data, [managed]);
  assert.equal(data.assets["emoji:500"], undefined);
  assert.deepEqual(archiveCandidates(data, "current").map(({ id }) => id), ["500"]);
  syncArchiveGuildAssets(data, []);
  assert.deepEqual(archiveCandidates(data, "history").map(({ id }) => id), ["500"]);
});

test("アニメーション形式を変換せずCDNの適切なURLを選ぶ", () => {
  assert.match(archiveUrls({ kind: "emoji", id: "300", animated: true })[0].url, /\.webp\?size=128&animated=true$/);
  assert.deepEqual(archiveUrls({ kind: "sticker", id: "400", formatType: 3 }).map(({ extension }) => extension), ["json"]);
  assert.deepEqual(archiveUrls({ kind: "sticker", id: "400", formatType: 2 }).map(({ extension }) => extension), ["png"]);
  assert.match(archiveUrls({ kind: "sticker", id: "400", formatType: 4 })[0].url, /^https:\/\/media\.discordapp\.net\/stickers\/400\.gif$/);
  assert.deepEqual(archiveUrls({ kind: "emoji", id: "../../unsafe" }), []);
});

test("取得した実画像をDATA_DIRへ保存し、次回はCDNにアクセスしない", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "emoji-archive-"));
  let calls = 0;
  try {
    const store = createArchiveStore(root, { fetcher: async (url) => {
      calls++;
      assert.match(url, /cdn\.discordapp\.com\/stickers\/400\.png/);
      return new Response(png, { status: 200, headers: { "content-type": "image/png" } });
    } });
    const candidate = { kind: "sticker", id: "400", formatType: 2 };
    const first = await store.get("123", candidate);
    assert.equal(first.extension, "png");
    assert.equal(first.cached, false);
    assert.equal((await store.get("123", candidate)).cached, true);
    assert.equal(calls, 1);
    assert.deepEqual(await fs.readFile(path.join(root, "123", "sticker", "400.png")), png);
    assert.equal(await store.get("../../escape", candidate), null);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("形式が後から判明した動くスタンプは静止画キャッシュよりアニメーションを優先する", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "emoji-archive-"));
  const gif = Buffer.from("GIF89a....", "ascii");
  try {
    const directory = path.join(root, "123", "sticker");
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, "400.png"), png);
    const store = createArchiveStore(root, { fetcher: async (url) => {
      assert.match(url, /^https:\/\/media\.discordapp\.net\/stickers\/400\.gif$/);
      return new Response(gif, { status: 200 });
    } });
    const result = await store.get("123", { kind: "sticker", id: "400", formatType: 4 });
    assert.equal(result.extension, "gif");
    assert.deepEqual(result.buffer, gif);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("動く絵文字は静止WebPキャッシュをそのまま採用せずアニメーションを保存する", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "emoji-archive-"));
  const webp = (animated) => {
    const buffer = Buffer.alloc(22);
    buffer.write("RIFF", 0);
    buffer.write("WEBP", 8);
    buffer.write("VP8X", 12);
    buffer.writeUInt32LE(1, 16);
    buffer[20] = animated ? 2 : 0;
    return buffer;
  };
  try {
    const directory = path.join(root, "123", "emoji");
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, "500.webp"), webp(false));
    let calls = 0;
    const store = createArchiveStore(root, { fetcher: async () => {
      calls++;
      return new Response(webp(true), { status: 200 });
    } });
    const result = await store.get("123", { kind: "emoji", id: "500", animated: true });
    assert.deepEqual(result.buffer, webp(true));
    assert.equal(calls, 1);
    assert.deepEqual(await fs.readFile(path.join(directory, "500.webp")), webp(true));
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("失われた画像を飛ばし、成功・失敗の目録をZIPへ収録する", async () => {
  const data = guildData(emptyDatabase(), "123");
  observeArchiveEvents(data, [{ kind: "emoji", id: "300", name: "saved" }, { kind: "emoji", id: "301", name: "deleted" }]);
  const result = await buildArchivePage(data, "123", {
    getMedia: async (_, asset) => asset.id === "300" ? { buffer: png, extension: "png" } : null
  });
  assert.deepEqual([result.saved, result.failed, result.pageCount, result.parts.length], [1, 1, 1, 1]);
  const zip = await JSZip.loadAsync(result.parts[0].buffer);
  assert.deepEqual(await zip.file("history_only/emoji/saved_300.png").async("nodebuffer"), png);
  const manifest = JSON.parse(await zip.file("manifest.json").async("string"));
  assert.equal(manifest.files[0].id, "300");
  assert.equal(manifest.failures[0].id, "301");
});

test("全候補を1回のアーカイブ生成で選択する", async () => {
  const data = guildData(emptyDatabase(), "123");
  observeArchiveEvents(data, Array.from({ length: 51 }, (_, index) => ({ kind: "emoji", id: String(300 + index), name: `emoji_${index}` })));
  const result = await buildArchivePage(data, "123", {
    getMedia: async () => ({ buffer: png, extension: "png" })
  });
  assert.equal(result.total, 51);
  assert.equal(result.selected, 51);
  assert.equal(result.pageCount, 1);
});

test("日本語の素材名をZIP内のファイル名へ保持する", async () => {
  const data = guildData(emptyDatabase(), "123");
  observeArchiveEvents(data, [{ kind: "sticker", id: "300", name: "こんにちは！" }]);
  const result = await buildArchivePage(data, "123", {
    getMedia: async () => ({ buffer: png, extension: "png" })
  });
  const zip = await JSZip.loadAsync(result.parts[0].buffer);
  assert.ok(zip.file("history_only/sticker/こんにちは！_300.png"));
});

test("Discordの添付容量を超える場合は独立したZIPへ分割する", async () => {
  const data = guildData(emptyDatabase(), "123");
  observeArchiveEvents(data, [{ kind: "emoji", id: "300", name: "one" }, { kind: "emoji", id: "301", name: "two" }]);
  const result = await buildArchivePage(data, "123", {
    attachmentLimit: 5 * 1024 * 1024,
    getMedia: async () => ({ buffer: Buffer.alloc(3 * 1024 * 1024, 1), extension: "webp" })
  });
  assert.equal(result.parts.length, 2);
  for (const part of result.parts) {
    assert.ok(part.buffer.length < 5 * 1024 * 1024);
    const zip = await JSZip.loadAsync(part.buffer);
    assert.ok(zip.file("manifest.json"));
  }
});
