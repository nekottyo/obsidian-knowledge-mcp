#!/usr/bin/env node
// MCP エントリポイント (stdio transport)
// search_knowledge / read_knowledge / reindex_knowledge の 3 ツールを提供する

import fs from "node:fs";
import path from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { getVaultRoot, syncIndex } from "./indexer.js";
import { DEFAULT_TOP_K, searchKnowledge } from "./search.js";
import { KnowledgeStore, type SearchFilter } from "./store.js";

/** search_knowledge の引数 */
interface SearchArgs {
  query: string;
  filter?: SearchFilter;
  top_k?: number;
}

/** read_knowledge の引数 */
interface ReadArgs {
  path: string;
}

/** reindex_knowledge の引数 */
interface ReindexArgs {
  scope?: string;
}

/** filter オブジェクトのプロパティ定義 (JSON Schema) */
const FILTER_SCHEMA = {
  type: "object",
  description:
    "Optional metadata filter based on note frontmatter (skill / repo / domain / type). " +
    "Matching is containment-based: a note can declare multiple domains, and it matches " +
    "if any one of them equals the given filter value.",
  properties: {
    skill: { type: "string" },
    repo: { type: "string" },
    domain: { type: "string" },
    type: { type: "string" },
  },
  additionalProperties: false,
} as const;

/** 3 ツールの定義 (description は英語) */
const TOOL_DEFINITIONS = [
  {
    name: "search_knowledge",
    description:
      "Claude Code skill knowledge search. Prefer this over reading full knowledge files. " +
      "Hybrid search (vector KNN + BM25, fused with RRF) over indexed knowledge markdown chunks. " +
      "Returns only the relevant chunks with path / heading / score, so it is much cheaper than reading whole files.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search query. Japanese or English natural language.",
        },
        filter: FILTER_SCHEMA,
        top_k: {
          type: "number",
          description: `Maximum number of chunks to return (default ${DEFAULT_TOP_K}).`,
        },
      },
      required: ["query"],
    },
  },
  {
    name: "read_knowledge",
    description:
      "Read the full content of a single knowledge note. " +
      "Accepts a path relative to VAULT_ROOT or an absolute path inside VAULT_ROOT. " +
      "Use only when search_knowledge chunks are not enough.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            "Note path, relative to VAULT_ROOT or absolute (must stay inside VAULT_ROOT).",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "reindex_knowledge",
    description:
      "Force a full re-index of knowledge notes, ignoring mtime-based change detection. " +
      "Optionally limited to a path prefix via scope. Returns an indexing summary.",
    inputSchema: {
      type: "object",
      properties: {
        scope: {
          type: "string",
          description: "Optional path prefix (relative to VAULT_ROOT) to limit the re-index scope.",
        },
      },
    },
  },
];

/** テキスト 1 件の MCP ツールレスポンスを作る */
function textResult(text: string, isError = false) {
  return { content: [{ type: "text" as const, text }], isError };
}

/**
 * read_knowledge のパス解決
 * 相対 / 絶対の両方を受け付け、VAULT_ROOT 外へのパストラバーサルは拒否する
 */
function resolveNotePath(inputPath: string): string {
  const vaultRoot = getVaultRoot();
  const absolute = path.isAbsolute(inputPath)
    ? path.normalize(inputPath)
    : path.resolve(vaultRoot, inputPath);
  if (absolute !== vaultRoot && !absolute.startsWith(vaultRoot + path.sep)) {
    console.error(`[read] rejected path traversal attempt outside VAULT_ROOT: ${inputPath}`);
    throw new Error(`path is outside VAULT_ROOT: ${inputPath}`);
  }
  return absolute;
}

async function main(): Promise<void> {
  // 環境変数の必須チェックを起動時に済ませる (不足時はここで落とす)
  getVaultRoot();
  const store = new KnowledgeStore();

  // 起動時の全スキャン。ollama 未起動などで失敗してもサーバー自体は起動し、
  // 各ツール呼び出し時の lazy 同期でリトライされる
  try {
    const result = await syncIndex(store);
    console.error(
      `[startup] index synced: scanned=${result.scannedFiles} indexed=${result.indexedFiles} removed=${result.removedFiles} chunks=${result.indexedChunks}`,
    );
  } catch (err) {
    console.error(`[startup] initial index sync failed: ${String(err)}`);
  }

  const server = new Server(
    { name: "obsidian-knowledge-mcp", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOL_DEFINITIONS,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    try {
      switch (name) {
        case "search_knowledge": {
          const { query, filter, top_k } = (args ?? {}) as unknown as SearchArgs;
          if (typeof query !== "string" || query.trim() === "") {
            return textResult("Error: query must be a non-empty string", true);
          }
          const result = await searchKnowledge(store, query, filter ?? {}, top_k ?? DEFAULT_TOP_K);
          return textResult(result.text);
        }
        case "read_knowledge": {
          const { path: notePath } = (args ?? {}) as unknown as ReadArgs;
          if (typeof notePath !== "string" || notePath.trim() === "") {
            return textResult("Error: path must be a non-empty string", true);
          }
          const absolute = resolveNotePath(notePath);
          const content = fs.readFileSync(absolute, "utf8");
          console.error(
            `[read] read_knowledge returned ${Buffer.byteLength(content, "utf8")} bytes for ${notePath}`,
          );
          return textResult(content);
        }
        case "reindex_knowledge": {
          const { scope } = (args ?? {}) as unknown as ReindexArgs;
          const result = await syncIndex(store, { force: true, scope });
          const summary =
            `Reindex completed.\n` +
            `scanned files: ${result.scannedFiles}\n` +
            `indexed files: ${result.indexedFiles}\n` +
            `indexed chunks: ${result.indexedChunks}\n` +
            `removed files: ${result.removedFiles}\n` +
            `total files in index: ${store.countFiles()}\n` +
            `total chunks in index: ${store.countChunks()}\n` +
            `frontmatter warnings: ${result.warnings.length}` +
            (result.warnings.length > 0
              ? `\n${result.warnings.map((w) => `  - ${w}`).join("\n")}`
              : "");
          console.error(
            `[reindex] forced reindex done: files=${result.indexedFiles} chunks=${result.indexedChunks} scope=${scope ?? "(all)"}`,
          );
          return textResult(summary);
        }
        default:
          return textResult(`Error: unknown tool: ${name}`, true);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[server] tool ${name} failed: ${message}`);
      return textResult(`Error: ${message}`, true);
    }
  });

  await server.connect(new StdioServerTransport());
  console.error("[startup] obsidian-knowledge-mcp server started on stdio");
}

main().catch((err) => {
  console.error(`[fatal] server failed to start: ${String(err)}`);
  process.exit(1);
});
