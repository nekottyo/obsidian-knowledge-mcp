// search_knowledge の共通実装
// MCP ツール (index.ts) / CLI (dev-search.ts) / eval ランナーで共有する

import { syncIndex } from "./indexer.js";
import { embedQuery } from "./ollama.js";
import type { KnowledgeStore, SearchFilter, SearchHit } from "./store.js";

/** top_k 未指定時の既定値 */
export const DEFAULT_TOP_K = 8;

/** 検索結果 (整形済みテキストと生ヒットの両方を返す) */
export interface SearchResult {
  hits: SearchHit[];
  /** MCP ツールがそのまま返す整形済みテキスト */
  text: string;
  /** 整形済みテキストのバイト数 (context 削減の実測用) */
  bytes: number;
}

/** ヒット一覧を返却用テキストに整形する。末尾に total bytes returned を付ける */
function formatHits(hits: SearchHit[]): { text: string; bytes: number } {
  const sections = hits.map((hit, index) =>
    [
      `[${index + 1}] path: ${hit.chunk.path}`,
      `heading: ${hit.chunk.heading}`,
      `score: ${hit.score.toFixed(6)}`,
      "content:",
      hit.chunk.content,
    ].join("\n"),
  );
  const body = sections.length > 0 ? sections.join("\n\n---\n\n") : "No results found.";
  const bytes = Buffer.byteLength(body, "utf8");
  return { text: `${body}\n\ntotal bytes returned: ${bytes}`, bytes };
}

/**
 * ハイブリッド検索を実行する
 * 呼び出し冒頭で必ず lazy にインデックス同期し、「検索した瞬間に最新」を保証する
 */
export async function searchKnowledge(
  store: KnowledgeStore,
  query: string,
  filter: SearchFilter = {},
  topK: number = DEFAULT_TOP_K,
): Promise<SearchResult> {
  // lazy 同期: ~50 ファイル規模なら stat 突合は安価
  await syncIndex(store);
  const queryEmbedding = await embedQuery(query);
  const hits = store.hybridSearch(queryEmbedding, query, filter, topK);
  const { text, bytes } = formatHits(hits);
  console.error(
    `[search] search_knowledge returned ${bytes} bytes (${hits.length} hits) for query: ${query}`,
  );
  return { hits, text, bytes };
}
