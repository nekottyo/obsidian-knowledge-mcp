// search_knowledge 相当を CLI から叩く動作確認用スクリプト
// 使い方: npm run dev-search -- "クエリ" [--skill X] [--repo X] [--domain X] [--type X] [--top-k N]

import { DEFAULT_TOP_K, searchKnowledge } from "./search.js";
import { KnowledgeStore, type SearchFilter } from "./store.js";

/** CLI 引数のパース結果 */
interface CliArgs {
  query: string;
  filter: SearchFilter;
  topK: number;
}

/** 素朴な CLI 引数パーサ */
function parseArgs(argv: string[]): CliArgs {
  const filter: SearchFilter = {};
  let query: string | undefined;
  let topK = DEFAULT_TOP_K;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) {
      continue;
    }
    if (arg === "--skill" || arg === "--repo" || arg === "--domain" || arg === "--type") {
      const value = argv[++i];
      if (value === undefined) {
        throw new Error(`missing value for ${arg}`);
      }
      filter[arg.slice(2) as keyof SearchFilter] = value;
    } else if (arg === "--top-k") {
      const value = argv[++i];
      if (value === undefined || Number.isNaN(Number(value))) {
        throw new Error("missing or invalid value for --top-k");
      }
      topK = Number(value);
    } else if (query === undefined) {
      query = arg;
    } else {
      // クォート無しで複数語を渡された場合は連結して 1 クエリ扱いにする
      query = `${query} ${arg}`;
    }
  }

  if (query === undefined || query.trim() === "") {
    throw new Error(
      'usage: npm run dev-search -- "<query>" [--skill X] [--repo X] [--domain X] [--type X] [--top-k N]',
    );
  }
  return { query, filter, topK };
}

async function main(): Promise<void> {
  const { query, filter, topK } = parseArgs(process.argv.slice(2));
  const store = new KnowledgeStore();
  try {
    const result = await searchKnowledge(store, query, filter, topK);
    console.log(result.text);
  } finally {
    store.close();
  }
}

main().catch((err) => {
  console.error(`[dev-search] failed: ${String(err)}`);
  process.exit(1);
});
