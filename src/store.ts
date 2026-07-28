// sqlite (better-sqlite3 + sqlite-vec + FTS5) の永続層
// files / chunks / chunk_meta / vec_chunks / fts_chunks の 5 テーブルを単一 sqlite ファイルに持つ
//
// この DB は vault (markdown + frontmatter) から常に再生成できる派生キャッシュである。
// スキーマを壊す変更を入れるときは SCHEMA_VERSION を上げ、旧テーブルを DROP して作り直せばよく、
// 移行スクリプトを書く必要は無い。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { EMBEDDING_DIM } from "./ollama.js";

/** DB_PATH 未指定時の既定パス */
const DEFAULT_DB_PATH = path.join(
  os.homedir(),
  ".local",
  "share",
  "obsidian-knowledge-mcp",
  "index.db",
);

/** vector / FTS それぞれから取る候補件数 (RRF 統合前) */
const CANDIDATE_LIMIT = 20;

/** RRF の定数 k */
const RRF_K = 60;

/**
 * スキーマ版。テーブル構造を変えたら必ず上げること
 * 版 1: skill/repo/domain/type を chunks の列として持つ単一値スキーマ
 * 版 2: chunk_meta テーブルによる複数値 (配列) 対応スキーマ
 */
const SCHEMA_VERSION = 2;

/** frontmatter からメタデータとして扱うキー */
const FRONTMATTER_KEYS = ["skill", "repo", "domain", "type"] as const;

/** files テーブルの 1 行 (差分検知用) */
export interface FileEntry {
  mtimeMs: number;
  size: number;
}

/** chunks テーブルへの挿入用レコード */
export interface ChunkInsert {
  heading: string;
  content: string;
  /** frontmatter 由来のメタデータ (key ごとに複数値を許容する) */
  meta: Record<string, string[]>;
}

/** chunks テーブルの 1 行 */
export interface ChunkRow {
  id: number;
  path: string;
  heading: string;
  content: string;
  /** chunk_meta から引いたメタデータ */
  meta: Record<string, string[]>;
}

/** search_knowledge の filter 条件 */
export interface SearchFilter {
  skill?: string;
  repo?: string;
  domain?: string;
  type?: string;
}

/** ハイブリッド検索のヒット 1 件 */
export interface SearchHit {
  chunk: ChunkRow;
  /** RRF スコア */
  score: number;
}

/** number[] を vec0 が受け取れる Float32 バイナリへ変換する */
function serializeEmbedding(embedding: number[]): Buffer {
  return Buffer.from(new Float32Array(embedding).buffer);
}

/**
 * FTS5 の MATCH 式を組み立てる
 * trigram tokenizer は 3 文字未満のトークンにマッチできないため、
 * 空白区切りトークンのうち 3 文字以上のものをダブルクォートで囲み OR で結合する
 * (クォートで囲むことで FTS5 クエリ構文エラーも回避する)
 */
function buildFtsMatchExpression(query: string): string | null {
  const tokens = query
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3);
  if (tokens.length === 0) {
    return null;
  }
  return tokens.map((token) => `"${token.replaceAll('"', '""')}"`).join(" OR ");
}

/** sqlite の永続層 */
export class KnowledgeStore {
  private readonly db: Database.Database;

  constructor(dbPath: string = process.env.DB_PATH ?? DEFAULT_DB_PATH) {
    // DB ディレクトリは自動作成する
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    sqliteVec.load(this.db);
    this.db.pragma("journal_mode = WAL");
    this.migrate();
  }

  /**
   * スキーマを作成する
   * PRAGMA user_version で版を管理し、版が一致しなければ全テーブルを作り直す
   * (`current !== 0` ではなく `current !== SCHEMA_VERSION` で判定すること。
   * 前者だと旧版の user_version=0 な DB で files テーブルが生き残り、
   * 差分検知が「変更なし」と誤判定して再索引が走らなくなる)
   */
  private migrate(): void {
    const current = this.db.pragma("user_version", { simple: true }) as number;
    if (current !== SCHEMA_VERSION) {
      // この DB は vault から常に再生成できる派生キャッシュなので、
      // 版が古い/新しいに関わらず DROP して作り直せば十分である
      this.db.exec(`
        DROP TABLE IF EXISTS fts_chunks;
        DROP TABLE IF EXISTS vec_chunks;
        DROP TABLE IF EXISTS chunk_meta;
        DROP TABLE IF EXISTS chunks;
        DROP TABLE IF EXISTS files;
      `);
    }

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS files (
        path TEXT PRIMARY KEY,
        mtime_ms INTEGER NOT NULL,
        size INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS chunks (
        id INTEGER PRIMARY KEY,
        path TEXT NOT NULL,
        heading TEXT NOT NULL,
        content TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_chunks_path ON chunks(path);

      CREATE TABLE IF NOT EXISTS chunk_meta (
        chunk_id INTEGER NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        PRIMARY KEY (chunk_id, key, value)
      ) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS idx_chunk_meta_kv ON chunk_meta(key, value);

      CREATE VIRTUAL TABLE IF NOT EXISTS vec_chunks USING vec0(
        chunk_id INTEGER PRIMARY KEY,
        embedding float[${EMBEDDING_DIM}] distance_metric=cosine
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS fts_chunks USING fts5(
        content,
        heading,
        tokenize='trigram'
      );
    `);

    this.db.pragma(`user_version = ${SCHEMA_VERSION}`);
  }

  /** files テーブルの全行を Map で返す */
  listFiles(): Map<string, FileEntry> {
    const rows = this.db
      .prepare("SELECT path, mtime_ms AS mtimeMs, size FROM files")
      .all() as Array<{ path: string; mtimeMs: number; size: number }>;
    return new Map(rows.map((row) => [row.path, { mtimeMs: row.mtimeMs, size: row.size }]));
  }

  /** 1 ファイル分のチャンクと embedding を丸ごと入れ替える (トランザクション) */
  replaceFileChunks(
    filePath: string,
    entry: FileEntry,
    chunks: Array<{ record: ChunkInsert; embedding: number[] }>,
  ): void {
    const insertChunk = this.db.prepare(`
      INSERT INTO chunks (path, heading, content)
      VALUES (?, ?, ?)
    `);
    const insertMeta = this.db.prepare(`
      INSERT INTO chunk_meta (chunk_id, key, value) VALUES (?, ?, ?)
    `);
    const insertVec = this.db.prepare("INSERT INTO vec_chunks (chunk_id, embedding) VALUES (?, ?)");
    const insertFts = this.db.prepare(
      "INSERT INTO fts_chunks (rowid, content, heading) VALUES (?, ?, ?)",
    );
    const upsertFile = this.db.prepare(`
      INSERT INTO files (path, mtime_ms, size) VALUES (?, ?, ?)
      ON CONFLICT(path) DO UPDATE SET mtime_ms = excluded.mtime_ms, size = excluded.size
    `);

    const transaction = this.db.transaction(() => {
      this.deleteChunksForPath(filePath);
      for (const { record, embedding } of chunks) {
        const result = insertChunk.run(filePath, record.heading, record.content);
        const chunkId = Number(result.lastInsertRowid);
        for (const key of FRONTMATTER_KEYS) {
          for (const value of record.meta[key] ?? []) {
            insertMeta.run(chunkId, key, value);
          }
        }
        // vec0 の主キーは INTEGER 必須のため、REAL と解釈されないよう BigInt で bind する
        insertVec.run(BigInt(chunkId), serializeEmbedding(embedding));
        insertFts.run(chunkId, record.content, record.heading);
      }
      upsertFile.run(filePath, Math.round(entry.mtimeMs), entry.size);
    });
    transaction();
  }

  /** ファイルを files / chunks / chunk_meta / vec / fts から削除する (トランザクション) */
  removeFile(filePath: string): void {
    const transaction = this.db.transaction(() => {
      this.deleteChunksForPath(filePath);
      this.db.prepare("DELETE FROM files WHERE path = ?").run(filePath);
    });
    transaction();
  }

  /** 指定パスに紐づくチャンクを chunks / chunk_meta / vec_chunks / fts_chunks から削除する */
  private deleteChunksForPath(filePath: string): void {
    const ids = (
      this.db.prepare("SELECT id FROM chunks WHERE path = ?").all(filePath) as Array<{ id: number }>
    ).map((row) => row.id);
    const deleteMeta = this.db.prepare("DELETE FROM chunk_meta WHERE chunk_id = ?");
    const deleteVec = this.db.prepare("DELETE FROM vec_chunks WHERE chunk_id = ?");
    const deleteFts = this.db.prepare("DELETE FROM fts_chunks WHERE rowid = ?");
    for (const id of ids) {
      deleteMeta.run(id);
      deleteVec.run(id);
      deleteFts.run(id);
    }
    this.db.prepare("DELETE FROM chunks WHERE path = ?").run(filePath);
  }

  /**
   * filter 条件にチャンクが合致するか (undefined の条件は無視)
   * 意味論は containment: そのチャンクの当該 key の値集合に filter の値が含まれていれば真
   * (単一値のノートに対しては現行の完全一致と同値なので後方互換が保たれる)
   * 複数キー間は従来どおり AND
   */
  private static matchesFilter(meta: Record<string, string[]>, filter: SearchFilter): boolean {
    return FRONTMATTER_KEYS.every((key) => {
      const want = filter[key];
      return want === undefined || (meta[key] ?? []).includes(want);
    });
  }

  /** id からチャンク行を引く (存在しない id は無視)。meta は chunk_meta から組み立てる */
  private getChunksByIds(ids: number[]): Map<number, ChunkRow> {
    if (ids.length === 0) {
      return new Map();
    }
    const placeholders = ids.map(() => "?").join(",");
    const rows = this.db
      .prepare(`SELECT id, path, heading, content FROM chunks WHERE id IN (${placeholders})`)
      .all(...ids) as Array<{
      id: number;
      path: string;
      heading: string;
      content: string;
    }>;
    const metaRows = this.db
      .prepare(
        `SELECT chunk_id AS chunkId, key, value FROM chunk_meta WHERE chunk_id IN (${placeholders})`,
      )
      .all(...ids) as Array<{ chunkId: number; key: string; value: string }>;

    const metaByChunk = new Map<number, Record<string, string[]>>();
    for (const row of metaRows) {
      const entry = metaByChunk.get(row.chunkId) ?? {};
      const values = entry[row.key] ?? [];
      values.push(row.value);
      entry[row.key] = values;
      metaByChunk.set(row.chunkId, entry);
    }

    const map = new Map<number, ChunkRow>();
    for (const row of rows) {
      map.set(row.id, {
        id: row.id,
        path: row.path,
        heading: row.heading,
        content: row.content,
        meta: metaByChunk.get(row.id) ?? {},
      });
    }
    return map;
  }

  /**
   * vector KNN 検索 (cosine)
   * filter が無いときは従来どおり CANDIDATE_LIMIT 件だけ取って post-filter する
   * filter があるときは k を全チャンク数まで引き上げてから絞り込み、post-filter による
   * リコール低下 (絞り込み後に上位が足りなくなる問題) を避ける
   * k の上限は 4096 (実測)。それを超える規模になったら vec0 の metadata 列による
   * 真の pre-filter への移行が必要
   */
  private vectorSearch(queryEmbedding: number[], filter: SearchFilter): number[] {
    const hasFilter = Object.values(filter).some((v) => v !== undefined);
    const k = hasFilter
      ? Math.min(4096, Math.max(CANDIDATE_LIMIT, this.countChunks()))
      : CANDIDATE_LIMIT;
    const rows = this.db
      .prepare(`
        SELECT chunk_id AS id, distance
        FROM vec_chunks
        WHERE embedding MATCH ? AND k = ${k}
        ORDER BY distance
      `)
      .all(serializeEmbedding(queryEmbedding)) as Array<{
      id: number;
      distance: number;
    }>;
    const chunkMap = this.getChunksByIds(rows.map((row) => row.id));
    return rows
      .map((row) => chunkMap.get(row.id))
      .filter((chunk): chunk is ChunkRow => chunk !== undefined)
      .filter((chunk) => KnowledgeStore.matchesFilter(chunk.meta, filter))
      .map((chunk) => chunk.id)
      .slice(0, CANDIDATE_LIMIT);
  }

  /** FTS5 BM25 検索。filter は chunk_meta を key ごとに絞り込んで WHERE に足す */
  private ftsSearch(query: string, filter: SearchFilter): number[] {
    const matchExpression = buildFtsMatchExpression(query);
    if (matchExpression === null) {
      return [];
    }
    const conditions: string[] = ["fts_chunks MATCH ?"];
    const params: unknown[] = [matchExpression];
    for (const key of FRONTMATTER_KEYS) {
      const value = filter[key];
      if (value !== undefined) {
        conditions.push("c.id IN (SELECT chunk_id FROM chunk_meta WHERE key = ? AND value = ?)");
        params.push(key, value);
      }
    }
    const rows = this.db
      .prepare(`
        SELECT c.id AS id
        FROM fts_chunks f
        JOIN chunks c ON c.id = f.rowid
        WHERE ${conditions.join(" AND ")}
        ORDER BY bm25(fts_chunks)
        LIMIT ${CANDIDATE_LIMIT}
      `)
      .all(...params) as Array<{ id: number }>;
    return rows.map((row) => row.id);
  }

  /**
   * vector KNN + FTS5 BM25 を RRF (k=60) で統合したハイブリッド検索
   * @returns RRF スコア降順の上位 topK 件
   */
  hybridSearch(
    queryEmbedding: number[],
    queryText: string,
    filter: SearchFilter,
    topK: number,
  ): SearchHit[] {
    const rankedLists = [
      this.vectorSearch(queryEmbedding, filter),
      this.ftsSearch(queryText, filter),
    ];
    // RRF: score(id) = Σ 1 / (RRF_K + rank)
    const scores = new Map<number, number>();
    for (const list of rankedLists) {
      list.forEach((id, index) => {
        scores.set(id, (scores.get(id) ?? 0) + 1 / (RRF_K + index + 1));
      });
    }
    const sortedIds = [...scores.entries()].sort((a, b) => b[1] - a[1]).slice(0, topK);
    const chunkMap = this.getChunksByIds(sortedIds.map(([id]) => id));
    const hits: SearchHit[] = [];
    for (const [id, score] of sortedIds) {
      const chunk = chunkMap.get(id);
      if (chunk) {
        hits.push({ chunk, score });
      }
    }
    return hits;
  }

  /** インデックス済みファイル数 */
  countFiles(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM files").get() as {
      n: number;
    };
    return row.n;
  }

  /** インデックス済みチャンク数 */
  countChunks(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM chunks").get() as {
      n: number;
    };
    return row.n;
  }

  /** DB を閉じる */
  close(): void {
    this.db.close();
  }
}
