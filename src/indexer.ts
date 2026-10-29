// ファイルスキャン + mtime 差分検知 + embedding 投入を行うインデクサ
// サーバー起動時と毎 search_knowledge 呼び出し冒頭に lazy 実行される

import fs from "node:fs";
import path from "node:path";
import { chunkMarkdown } from "./chunker.js";
import { embedTexts } from "./ollama.js";
import type { FileEntry, KnowledgeStore } from "./store.js";

/** インデックス同期のオプション */
export interface SyncOptions {
  /** true なら mtime を無視して全ファイル再構築する */
  force?: boolean;
  /** VAULT_ROOT からの相対パス prefix。指定時はこの配下だけを対象にする */
  scope?: string;
}

/** インデックス同期の結果サマリ */
export interface SyncResult {
  /** スキャンで見つかった対象ファイル数 */
  scannedFiles: number;
  /** 再チャンク・再 embed したファイル数 */
  indexedFiles: number;
  /** インデックスから削除したファイル数 */
  removedFiles: number;
  /** 再インデックスで投入したチャンク数 */
  indexedChunks: number;
  /** frontmatter パース時の警告 (壊れた YAML / drift 検知など) */
  warnings: string[];
}

/** VAULT_ROOT (必須) を検証して絶対パスで返す */
export function getVaultRoot(): string {
  const vaultRoot = process.env.VAULT_ROOT;
  if (!vaultRoot) {
    console.error("[config] VAULT_ROOT environment variable is required");
    throw new Error("VAULT_ROOT environment variable is required");
  }
  return path.resolve(vaultRoot);
}

/** KNOWLEDGE_DIR (必須、VAULT_ROOT からの相対 dir をカンマ区切りで複数指定可) を返す */
export function getKnowledgeDirs(): string[] {
  const dirs = (process.env.KNOWLEDGE_DIR ?? "")
    .split(",")
    .map((d) => d.trim())
    .filter((d) => d !== "");
  if (dirs.length === 0) {
    console.error("[config] KNOWLEDGE_DIR environment variable is required");
    throw new Error("KNOWLEDGE_DIR environment variable is required");
  }
  return dirs;
}

/** knowledge dir 配下の *.md を再帰的にスキャンし、VAULT_ROOT 相対パス → stat 情報を返す */
function scanMarkdownFiles(): Map<string, FileEntry> {
  const vaultRoot = getVaultRoot();
  const baseDirs = getKnowledgeDirs().map((d) => path.join(vaultRoot, d));
  for (const baseDir of baseDirs) {
    if (!fs.existsSync(baseDir)) {
      console.error(`[indexer] knowledge directory does not exist: ${baseDir}`);
      throw new Error(`knowledge directory does not exist: ${baseDir}`);
    }
  }

  const found = new Map<string, FileEntry>();
  const walk = (dir: string): void => {
    for (const dirent of fs.readdirSync(dir, { withFileTypes: true })) {
      const absolute = path.join(dir, dirent.name);
      if (dirent.isDirectory()) {
        walk(absolute);
      } else if (dirent.isFile() && dirent.name.endsWith(".md")) {
        const stat = fs.statSync(absolute);
        const relative = path.relative(vaultRoot, absolute);
        found.set(relative, { mtimeMs: stat.mtimeMs, size: stat.size });
      }
    }
  };
  for (const baseDir of baseDirs) {
    walk(baseDir);
  }
  return found;
}

/** scope prefix に合致するか (scope 未指定なら常に true) */
function matchesScope(relativePath: string, scope: string | undefined): boolean {
  if (scope === undefined || scope === "") {
    return true;
  }
  const normalized = path.normalize(scope).replace(/^\.\//, "");
  return relativePath.startsWith(normalized);
}

/**
 * files テーブルと実ファイルの mtime/size を突合し、差分だけ再チャンク・再 embed する
 * 削除されたファイルは chunks / vec / fts からも削除する
 */
export async function syncIndex(
  store: KnowledgeStore,
  options: SyncOptions = {},
): Promise<SyncResult> {
  const { force = false, scope } = options;
  const vaultRoot = getVaultRoot();
  const onDisk = scanMarkdownFiles();
  const indexed = store.listFiles();

  const result: SyncResult = {
    scannedFiles: 0,
    indexedFiles: 0,
    removedFiles: 0,
    indexedChunks: 0,
    warnings: [],
  };

  // ディスクから消えたファイルをインデックスから削除する
  for (const indexedPath of indexed.keys()) {
    if (!matchesScope(indexedPath, scope)) {
      continue;
    }
    if (!onDisk.has(indexedPath)) {
      store.removeFile(indexedPath);
      result.removedFiles++;
      console.error(`[indexer] removed stale file from index: ${indexedPath}`);
    }
  }

  // 変化した (または force 指定された) ファイルだけ再インデックスする
  for (const [relativePath, entry] of onDisk) {
    if (!matchesScope(relativePath, scope)) {
      continue;
    }
    result.scannedFiles++;
    const known = indexed.get(relativePath);
    const unchanged =
      known !== undefined &&
      Math.round(known.mtimeMs) === Math.round(entry.mtimeMs) &&
      known.size === entry.size;
    if (unchanged && !force) {
      continue;
    }

    const raw = fs.readFileSync(path.join(vaultRoot, relativePath), "utf8");
    const fileWarnings: string[] = [];
    const chunks = chunkMarkdown(relativePath, raw, fileWarnings);
    for (const warning of fileWarnings) {
      result.warnings.push(warning);
      console.error(`[indexer] frontmatter warning: ${warning}`);
    }
    const embeddings = await embedTexts(chunks.map((chunk) => chunk.embeddingInput));
    store.replaceFileChunks(
      relativePath,
      entry,
      chunks.map((chunk, i) => {
        const embedding = embeddings[i];
        if (!embedding) {
          throw new Error(`embedding missing for chunk ${i} of ${relativePath}`);
        }
        return {
          record: {
            heading: chunk.heading,
            content: chunk.content,
            meta: chunk.meta,
          },
          embedding,
        };
      }),
    );
    result.indexedFiles++;
    result.indexedChunks += chunks.length;
    console.error(`[indexer] indexed ${relativePath}: ${chunks.length} chunks`);
  }

  return result;
}
