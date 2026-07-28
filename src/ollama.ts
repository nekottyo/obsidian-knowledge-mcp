// ollama の /api/embed を呼び出す embedding クライアント
// fetch のみで実装し、追加の HTTP ライブラリには依存しない

/** ollama サーバーの URL (環境変数 OLLAMA_URL、既定は localhost) */
const OLLAMA_URL = process.env.OLLAMA_URL ?? "http://localhost:11434";

/** embedding モデル名 (環境変数 EMBED_MODEL、既定は bge-m3) */
const EMBED_MODEL = process.env.EMBED_MODEL ?? "bge-m3";

/** bge-m3 の embedding 次元数。vec0 テーブル定義と一致させる */
export const EMBEDDING_DIM = 1024;

/** 1 回の /api/embed 呼び出しに載せる入力テキストの最大件数 */
const BATCH_SIZE = 16;

/** /api/embed のレスポンス形式 */
interface EmbedResponse {
  embeddings?: number[][];
}

/**
 * テキスト配列を 1 バッチとして embedding する
 * 失敗時は英語ログを stderr に出してから例外を投げる
 */
async function embedBatch(inputs: string[]): Promise<number[][]> {
  const url = `${OLLAMA_URL}/api/embed`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: EMBED_MODEL, input: inputs }),
    });
  } catch (err) {
    console.error(`[ollama] embed request failed to reach ${url}: ${String(err)}`);
    throw new Error(`ollama embed request failed: cannot reach ${url}. Is ollama running?`);
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "<unreadable body>");
    console.error(
      `[ollama] embed request failed: status=${res.status} model=${EMBED_MODEL} body=${body}`,
    );
    throw new Error(
      `ollama embed request failed with status ${res.status} (model=${EMBED_MODEL}): ${body}`,
    );
  }

  const json = (await res.json()) as EmbedResponse;
  const embeddings = json.embeddings;
  if (!Array.isArray(embeddings) || embeddings.length !== inputs.length) {
    console.error(
      `[ollama] embed response is malformed: expected ${inputs.length} embeddings, got ${embeddings?.length ?? "none"}`,
    );
    throw new Error("ollama embed response is malformed");
  }
  for (const vec of embeddings) {
    if (vec.length !== EMBEDDING_DIM) {
      console.error(
        `[ollama] embedding dimension mismatch: expected ${EMBEDDING_DIM}, got ${vec.length}. Check EMBED_MODEL.`,
      );
      throw new Error(`embedding dimension mismatch: expected ${EMBEDDING_DIM}, got ${vec.length}`);
    }
  }
  return embeddings;
}

/**
 * テキスト配列を BATCH_SIZE ごとに分割して embedding する
 * 入力順と同じ順序で embedding を返す
 */
export async function embedTexts(inputs: string[]): Promise<number[][]> {
  if (inputs.length === 0) {
    return [];
  }
  const results: number[][] = [];
  for (let i = 0; i < inputs.length; i += BATCH_SIZE) {
    const batch = inputs.slice(i, i + BATCH_SIZE);
    const embeddings = await embedBatch(batch);
    results.push(...embeddings);
  }
  return results;
}

/** 検索クエリ 1 件を embedding する */
export async function embedQuery(query: string): Promise<number[]> {
  const [embedding] = await embedTexts([query]);
  if (!embedding) {
    throw new Error("ollama returned no embedding for query");
  }
  return embedding;
}
