// chunker.ts の frontmatter パース回帰テスト
// yaml ベースのパーサが複数値 (配列) を正しく扱えること、
// および壊れた frontmatter で例外を投げないことを確認する

import assert from "node:assert/strict";
import { test } from "node:test";
import { chunkMarkdown, toValues } from "../src/chunker.js";

test("toValues: スカラは 1 要素配列になる", () => {
  assert.deepEqual(toValues("domain-a"), ["domain-a"]);
});

test("toValues: number/boolean は String() される", () => {
  assert.deepEqual(toValues(123), ["123"]);
  assert.deepEqual(toValues(true), ["true"]);
});

test("toValues: null/undefined は空配列になる", () => {
  assert.deepEqual(toValues(null), []);
  assert.deepEqual(toValues(undefined), []);
});

test("toValues: 配列は各要素を文字列化する", () => {
  assert.deepEqual(toValues(["a", "b"]), ["a", "b"]);
  assert.deepEqual(toValues([1, 2]), ["1", "2"]);
});

test("toValues: object (ネスト) は空配列になる", () => {
  assert.deepEqual(toValues({ nested: true }), []);
});

test('chunkMarkdown: ブロック配列の domain が ["a","b"] になる', () => {
  const raw = [
    "---",
    "skill: skill-a",
    "domain:",
    "  - domain-a",
    "  - domain-b",
    "---",
    "# タイトル",
    "",
    "本文がここに入る。",
  ].join("\n");
  const chunks = chunkMarkdown("note.md", raw);
  assert.ok(chunks.length > 0, "チャンクが生成されていること");
  assert.deepEqual(chunks[0]?.meta.domain, ["domain-a", "domain-b"]);
});

test('chunkMarkdown: インライン配列 [a, b] が ["a","b"] になる (現行の "[a, b]" 文字列化からの回帰テスト)', () => {
  const raw = [
    "---",
    "skill: skill-a",
    "domain: [domain-a, domain-b]",
    "---",
    "# タイトル",
    "",
    "本文がここに入る。",
  ].join("\n");
  const chunks = chunkMarkdown("note.md", raw);
  assert.deepEqual(chunks[0]?.meta.domain, ["domain-a", "domain-b"]);
});

test("chunkMarkdown: スカラの domain は 1 要素配列になる", () => {
  const raw = ["---", "domain: domain-a", "---", "# タイトル", "", "本文がここに入る。"].join("\n");
  const chunks = chunkMarkdown("note.md", raw);
  assert.deepEqual(chunks[0]?.meta.domain, ["domain-a"]);
});

test("chunkMarkdown: tags: の値が skill/repo/domain/type の 4 key を汚染しない", () => {
  const raw = [
    "---",
    "tags:",
    "  - type/craft",
    "  - domain/domain-a",
    "skill: skill-a",
    "---",
    "# タイトル",
    "",
    "本文がここに入る。",
  ].join("\n");
  const warnings: string[] = [];
  const chunks = chunkMarkdown("note.md", raw, warnings);
  // domain: key 自体は無いので domain は空配列のまま (tags の domain/domain-a が紛れ込まない)
  assert.deepEqual(chunks[0]?.meta.domain, []);
  // type: key も無いので空配列 (tags の type/craft が紛れ込まない)
  assert.deepEqual(chunks[0]?.meta.type, []);
  assert.deepEqual(chunks[0]?.meta.skill, ["skill-a"]);
  // drift 検知: domain/* タグがあるのに domain: key が無いので警告が出る
  assert.ok(
    warnings.some((w) => w.includes("has domain/* tags but no `domain:` key")),
    "drift 警告が出ていること",
  );
});

test("chunkMarkdown: frontmatter が無いファイルでも例外を投げない", () => {
  const raw = "# タイトル\n\n本文だけのファイル。";
  assert.doesNotThrow(() => {
    const chunks = chunkMarkdown("note.md", raw);
    assert.deepEqual(chunks[0]?.meta.skill, []);
  });
});

test("chunkMarkdown: 閉じ `---` が欠落していても例外を投げない", () => {
  const raw = ["---", "skill: skill-a", "# タイトル", "", "本文。"].join("\n");
  assert.doesNotThrow(() => {
    const chunks = chunkMarkdown("note.md", raw);
    // 閉じ区切りが無いので frontmatter とはみなされず、全体が本文扱いになる
    assert.deepEqual(chunks[0]?.meta.skill, []);
  });
});

test("chunkMarkdown: YAML 構文エラーでも例外を投げず frontmatter 無しにフォールバックする", () => {
  const raw = ["---", "skill: [unclosed", "---", "# タイトル", "", "本文。"].join("\n");
  const warnings: string[] = [];
  assert.doesNotThrow(() => {
    const chunks = chunkMarkdown("note.md", raw, warnings);
    assert.deepEqual(chunks[0]?.meta.skill, []);
  });
  assert.ok(warnings.length > 0, "YAML パース失敗の警告が記録されていること");
});

test("chunkMarkdown: pr: 123 のような数値キーがあっても 4 key の抽出が壊れない", () => {
  const raw = [
    "---",
    "skill: skill-a",
    "repo: repo-a",
    "pr: 123",
    "type: review",
    "---",
    "# タイトル",
    "",
    "本文。",
  ].join("\n");
  const chunks = chunkMarkdown("note.md", raw);
  assert.deepEqual(chunks[0]?.meta.skill, ["skill-a"]);
  assert.deepEqual(chunks[0]?.meta.repo, ["repo-a"]);
  assert.deepEqual(chunks[0]?.meta.type, ["review"]);
});
