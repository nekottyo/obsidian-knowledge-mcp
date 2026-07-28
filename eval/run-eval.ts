// golden query 評価ランナー
// eval/golden-queries.json の各 query を search し、hit@1 / hit@3 / hit@10 を判定する
// テストのログメッセージは日本語で出す

import fs from "node:fs";
import path from "node:path";
import { searchKnowledge } from "../src/search.js";
import { KnowledgeStore, type SearchFilter } from "../src/store.js";

/** golden query 1 件の形式 */
interface GoldenQuery {
  query: string;
  filter?: SearchFilter;
  /** ヒットの path にこの文字列が含まれること */
  expect_path_contains: string;
  /** 指定時はさらにチャンク本文にこの文字列が含まれること */
  expect_content_contains?: string;
}

/** 1 query の評価結果 */
interface EvalResult {
  query: string;
  /** 期待を満たした最上位ヒットの順位 (1 始まり)。未ヒットなら null */
  rank: number | null;
}

/** 評価時の検索件数 (hit@10 まで判定するため 10 固定) */
const EVAL_TOP_K = 10;

/** golden-queries.json のパス (npm run はパッケージルートで実行される前提) */
const GOLDEN_QUERIES_PATH = path.join(process.cwd(), "eval", "golden-queries.json");

/** スキーマ例のパス。実データが無いときの案内に使う */
const EXAMPLE_QUERIES_PATH = path.join(process.cwd(), "eval", "golden-queries.example.json");

async function main(): Promise<void> {
  // 実データは vault 本文の抜粋を含むためコミットしておらず、clone 直後は存在しない
  if (!fs.existsSync(GOLDEN_QUERIES_PATH)) {
    console.log(`golden query ファイルが無いため評価をスキップした (${GOLDEN_QUERIES_PATH})`);
    console.log(`${EXAMPLE_QUERIES_PATH} をコピーし、自分の vault に合わせて書き換えること`);
    return;
  }

  const goldenQueries = JSON.parse(fs.readFileSync(GOLDEN_QUERIES_PATH, "utf8")) as GoldenQuery[];

  if (goldenQueries.length === 0) {
    console.log(`golden query が 0 件のため評価をスキップした (${GOLDEN_QUERIES_PATH})`);
    return;
  }

  const store = new KnowledgeStore();
  const results: EvalResult[] = [];
  try {
    for (const golden of goldenQueries) {
      const { hits } = await searchKnowledge(store, golden.query, golden.filter ?? {}, EVAL_TOP_K);
      // 期待条件を満たす最上位ヒットの順位を求める
      let rank: number | null = null;
      for (let i = 0; i < hits.length; i++) {
        const hit = hits[i];
        if (!hit) {
          continue;
        }
        const pathOk = hit.chunk.path.includes(golden.expect_path_contains);
        const contentOk =
          golden.expect_content_contains === undefined ||
          hit.chunk.content.includes(golden.expect_content_contains);
        if (pathOk && contentOk) {
          rank = i + 1;
          break;
        }
      }
      results.push({ query: golden.query, rank });
    }
  } finally {
    store.close();
  }

  // 結果テーブルを表示する
  console.log("");
  console.log("=== golden query 評価結果 ===");
  const table = results.map((result) => ({
    query: result.query,
    順位: result.rank ?? "-",
    "hit@1": result.rank !== null && result.rank <= 1 ? "o" : "x",
    "hit@3": result.rank !== null && result.rank <= 3 ? "o" : "x",
    "hit@10": result.rank !== null && result.rank <= 10 ? "o" : "x",
  }));
  console.table(table);

  const total = results.length;
  const hitAt = (k: number) =>
    results.filter((result) => result.rank !== null && result.rank <= k).length;
  console.log(`合計: ${total} 件`);
  console.log(`hit@1  : ${hitAt(1)} / ${total}`);
  console.log(`hit@3  : ${hitAt(3)} / ${total}`);
  console.log(`hit@10 : ${hitAt(10)} / ${total}`);

  if (hitAt(EVAL_TOP_K) < total) {
    console.log("hit@10 に到達しなかった query があるため異常終了する");
    process.exit(1);
  }
  console.log("全 query が hit@10 を満たした");
}

main().catch((err) => {
  console.error(`[eval] evaluation runner failed: ${String(err)}`);
  process.exit(1);
});
