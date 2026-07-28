// KnowledgeStore (chunk_meta 対応後) のテスト
// :memory: / 一時ファイルの sqlite に対して直接検証する

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import Database from "better-sqlite3";
import { EMBEDDING_DIM } from "../src/ollama.js";
import { type ChunkInsert, KnowledgeStore, type SearchFilter } from "../src/store.js";

/** ダミーの embedding (次元だけ合わせたゼロベクトル) */
function dummyEmbedding(): number[] {
  return new Array(EMBEDDING_DIM).fill(0);
}

/** private メソッドをテストから呼ぶための最小限のキャスト */
function ftsSearch(store: KnowledgeStore, query: string, filter: SearchFilter): number[] {
  // ftsSearch は private のため as unknown 経由で直接呼び出す
  return (store as unknown as { ftsSearch: (q: string, f: SearchFilter) => number[] }).ftsSearch(
    query,
    filter,
  );
}

test("chunk_meta: 複数値 domain の containment フィルタが効く", () => {
  const store = new KnowledgeStore(":memory:");
  try {
    // 配列添字経由だと noUncheckedIndexedAccess で undefined が混ざるため、チャンクごとに束縛する
    const note1h1: ChunkInsert = {
      heading: "note1 > h1",
      content: "レビュー本文 alpha keyword です",
      meta: { skill: ["skill-a"], repo: [], domain: ["domain-a", "domain-b"], type: [] },
    };
    const note1h2: ChunkInsert = {
      heading: "note1 > h2",
      content: "レビュー本文 beta keyword です",
      meta: { skill: ["skill-a"], repo: [], domain: ["domain-c"], type: [] },
    };
    const note2h1: ChunkInsert = {
      heading: "note2 > h1",
      content: "レビュー本文 gamma keyword です",
      meta: { skill: ["other-skill"], repo: [], domain: ["domain-a"], type: [] },
    };
    store.replaceFileChunks(
      "note1.md",
      { mtimeMs: 1, size: 1 },
      [note1h1, note1h2].map((record) => ({ record, embedding: dummyEmbedding() })),
    );
    store.replaceFileChunks(
      "note2.md",
      { mtimeMs: 1, size: 1 },
      [note2h1].map((record) => ({ record, embedding: dummyEmbedding() })),
    );

    // domain=domain-a は note1>h1 と note2>h1 の 2 チャンクにヒットする (containment)
    const domainOnly = ftsSearch(store, "keyword", { domain: "domain-a" });
    assert.equal(domainOnly.length, 2, "domain の containment で 2 件ヒットすること");

    // 複数キー AND: domain=domain-a かつ skill=skill-a は note1>h1 だけ
    const domainAndSkill = ftsSearch(store, "keyword", {
      domain: "domain-a",
      skill: "skill-a",
    });
    assert.equal(domainAndSkill.length, 1, "複数キーの AND で 1 件に絞られること");

    // domain-c は note1>h2 だけにヒットする
    const domainC = ftsSearch(store, "keyword", { domain: "domain-c" });
    assert.equal(domainC.length, 1, "domain=domain-c は 1 件だけヒットすること");
  } finally {
    store.close();
  }
});

test("スキーマ版不一致で DB が作り直される", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "obsidian-knowledge-mcp-test-"));
  const dbPath = path.join(tmpDir, "index.db");
  try {
    // 1 回目: 通常どおり開いてチャンクを 1 件投入する
    const store1 = new KnowledgeStore(dbPath);
    store1.replaceFileChunks("note.md", { mtimeMs: 1, size: 1 }, [
      {
        record: {
          heading: "note > h1",
          content: "本文",
          meta: { skill: ["skill-a"], repo: [], domain: [], type: [] },
        },
        embedding: dummyEmbedding(),
      },
    ]);
    assert.equal(store1.countChunks(), 1, "1 件目投入直後は chunks が 1 件であること");
    store1.close();

    // DB ファイルを直接開いて user_version をわざと壊す (旧スキーマを装う)
    const raw = new Database(dbPath);
    raw.pragma("user_version = 99");
    raw.close();

    // 2 回目: SCHEMA_VERSION と不一致なので全テーブルが作り直され、データが消えること
    const store2 = new KnowledgeStore(dbPath);
    try {
      assert.equal(store2.countChunks(), 0, "版不一致でテーブルが作り直され chunks が空になること");
      assert.equal(store2.countFiles(), 0, "版不一致で files も空になること");

      const rawAfter = new Database(dbPath);
      const version = rawAfter.pragma("user_version", { simple: true }) as number;
      rawAfter.close();
      assert.equal(version, 2, "作り直し後の user_version が SCHEMA_VERSION と一致すること");
    } finally {
      store2.close();
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
