# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## コマンド

```sh
npm run build                                   # tsc
npm test                                        # tsc してから dist/test/*.test.js を node --test で実行
node --test dist/test/chunker.test.js           # 単一ファイル (先に npm run build が必要)
node --test --test-name-pattern "containment" dist/test/*.test.js   # 単一テスト

npm run check                                   # Biome の lint + format 検査 (書き込みなし)
npm run check:fix                               # 検査して安全な自動修正を適用
npm run format                                  # format のみ適用
npm run lint                                    # lint のみ
```

テストは `src/` ではなく `dist/` のビルド出力を実行する。`npm test` は毎回 `tsc` を挟むが、`node --test` を直接叩くときはビルドが古いままにならないよう注意する。

lint / format は Biome (`biome.json`) に集約している。`vcs.useIgnoreFile` を有効にしてあるので対象範囲は `.gitignore` に従う (`dist/` と `node_modules/` は自動で外れる)。`check:fix` で消えない指摘には `--unsafe` でしか直せないものが混ざる。当てるなら `npx biome check --write --unsafe` の後に必ず `npm test` まで通すこと。

動作確認とデータ投入には `VAULT_ROOT` / `KNOWLEDGE_DIR` と起動済みの ollama が要る (環境変数の一覧は README.md)。

```sh
VAULT_ROOT=/path/to/vault KNOWLEDGE_DIR=knowledge npm run dev-search -- "クエリ" --top-k 5
VAULT_ROOT=/path/to/vault KNOWLEDGE_DIR=knowledge npm run eval
```

## アーキテクチャ

エントリポイントは 3 つ (`src/index.ts` の MCP サーバー、`src/dev-search.ts` の CLI、`eval/run-eval.ts`) あるが、いずれも `src/search.ts` の `searchKnowledge()` を共有する。検索ロジックを変えるときはこの 1 箇所を見ればよい。

`searchKnowledge()` は冒頭で必ず `syncIndex()` を呼ぶ。これが「検索した瞬間に必ず最新」を担保する設計の中核であり、インデックス更新は独立したバックグラウンド処理ではなく検索パスに埋め込まれている。同期は mtime/size の突合なので、変化が無ければ stat のコストしかかからない。

データの流れは `chunker.ts` (markdown → チャンク + frontmatter) → `ollama.ts` (チャンク → embedding) → `store.ts` (sqlite へ投入) の一方向。`indexer.ts` がこの 3 つを束ねてファイル走査と差分検知を担う。

## 変更時に壊しやすい結合

**embedding 次元** — `ollama.ts` の `EMBEDDING_DIM` (1024) が `store.ts` の `vec0` テーブル定義に文字列展開されている。`EMBED_MODEL` を次元の違うモデルへ変えるなら、この定数と既存 DB の両方を作り直す必要がある。次元不一致は投入時ではなく `embedBatch()` の検証で先に落ちる。

**スキーマ版** — DB は vault から常に再生成できる派生キャッシュなので、テーブル構造を変えたら `store.ts` の `SCHEMA_VERSION` を上げるだけでよく、移行スクリプトは書かない。版が違えば全テーブルを DROP して作り直す。判定は `current !== SCHEMA_VERSION` であって `!== 0` ではない (後者だと `user_version=0` の旧 DB で `files` テーブルが生き残り、差分検知が「変更なし」と誤判定して再索引が走らなくなる)。

**stdout** — MCP は stdio transport で stdout を JSON-RPC に使う。ログは必ず `console.error` で stderr へ出す。`console.log` を使ってよいのは CLI (`dev-search.ts`) と eval ランナーだけ。

## 検索の非対称性と既知の癖

vector 側と FTS 側で filter の効かせ方が違う。FTS は `chunk_meta` を参照する `WHERE` 句による pre-filter、vector は KNN の `k` を全チャンク数まで引き上げてから絞り込む post-filter (上限 4096、超えるようなら `vec0` の metadata 列による真の pre-filter への移行が要る)。post-filter にしているのは、絞り込み後に上位が足りなくなるリコール低下を避けるため。

FTS5 の trigram tokenizer は 3 文字未満の語にマッチできないので、`buildFtsMatchExpression()` は 3 文字以上のトークンだけを OR 結合する。2 文字の日本語 (例: 「評価」) は BM25 側では拾えず vector 側だけが補完する。検索精度の変更を入れたら `npm run eval` の hit@k で回帰を見る。

filter の意味論は containment。`chunk_meta` が `(chunk_id, key, value)` の複数行を持つので、`domain` を複数宣言したノートはいずれか 1 つが一致すればヒットする。キーどうしは AND。

## チャンク分割

`##` / `###` 単位で切り、3200 文字を超えたら段落境界でさらに割る。コードフェンス内の `##` は見出しとみなさない。`heading` は `相対パス > h2 > h3` のパンくずで、embedding への入力はこのパンくずと本文を連結したもの。パンくずを入力に含めることで、本文だけでは文脈が失われるチャンクの検索精度を補っている。

frontmatter は `---` ブロックの切り出しだけ自前で行い、中身は `yaml` パッケージに任せる。YAML 構文エラーのノートは例外を投げず frontmatter 無しへフォールバックする (1 本の壊れたノートで索引全体を落とさないため)。`tags` に `domain/*` があるのに `domain:` キーが無いノートは filter に掛からないので、drift として警告を出す。

## テストと eval の注意

`test/` 配下は実 vault にも ollama にも依存せず、sqlite は `:memory:` か一時ファイル、embedding は次元だけ合わせたゼロベクトルで完結する。テストを足すときもこの性質を壊さないこと (特定の vault を前提にしたり、ノート数を決め打ちで assert したりしない)。

一方 `npm run eval` は実 vault と ollama の両方を要求する。`eval/golden-queries.json` は期待する path や本文断片という形で vault 本文の抜粋を含むため gitignore してあり、スキーマ例の `eval/golden-queries.example.json` だけが追跡対象になっている。実データはローカルにのみ置く。ファイルが無ければ eval は評価をスキップして正常終了する。

## 言語規約

- コード内のコメントと JSDoc は日本語
- 実行時ログ・エラーメッセージ・MCP ツールの description は英語
- テストのアサーションメッセージとテスト名は日本語
