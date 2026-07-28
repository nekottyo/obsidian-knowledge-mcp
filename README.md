# obsidian-knowledge-mcp

Obsidian vault の知識ノート (learnings / references / reviews などの markdown) を、全文読みせず vector + BM25 ハイブリッド検索で必要チャンクだけ取得するための MCP サーバーである。Claude Code の skill が抱える知識ファイルを検索対象とすることを想定している。

## 重要な前提

**vault リポジトリは public 化しない前提である。** このサーバーは vault 内の知識本文をローカル sqlite (`DB_PATH`) にインデックスし、検索結果としてチャンク本文をそのまま返す。vault 本体・インデックス DB のいずれも公開してはならない。

## アーキテクチャ

- チャンク分割: markdown を `##` / `###` 見出し単位で分割し、約 3200 文字を超える場合は段落境界でさらに分割する。frontmatter (`skill` / `repo` / `domain` / `type`) は `yaml` パッケージ (YAML 1.2) でパースし、`chunk_meta` テーブルへメタデータとして展開してフィルタに使う。各キーは複数値 (配列) を許容し、ノートは例えば `domain` に複数のドメインを宣言できる
- embedding: ollama の `/api/embed` (既定モデル bge-m3、1024 次元)
- 検索: sqlite-vec の vec0 による KNN (cosine) と FTS5 (`tokenize='trigram'`) の BM25 を各 top 20 取得し、RRF (k=60) で統合する
- インデックス更新: サーバー起動時と毎 `search_knowledge` 呼び出し冒頭に mtime/size 突合の lazy 同期を行い、変化したファイルだけ再チャンク・再 embed する。検索した瞬間に必ず最新であることを保証する

## 前提

- Node.js v24 以上
- ollama が起動しており、embedding モデルを取得済みであること

```sh
ollama pull bge-m3
```

## セットアップ

```sh
npm install
npm run build
```

### Claude Code への登録例

```sh
claude mcp add obsidian-knowledge \
  --env VAULT_ROOT=/path/to/obsidian-vault \
  --env KNOWLEDGE_DIR=knowledge \
  -- node /path/to/obsidian-knowledge-mcp/dist/src/index.js
```

## 環境変数

| 変数 | 必須 | 既定値 | 説明 |
|------|------|--------|------|
| `VAULT_ROOT` | yes | - | 検索対象のルートディレクトリ (絶対パス) |
| `KNOWLEDGE_DIR` | yes | - | `VAULT_ROOT` 配下の相対ディレクトリ。この配下の `**/*.md` がインデックス対象 |
| `OLLAMA_URL` | no | `http://localhost:11434` | ollama サーバーの URL |
| `EMBED_MODEL` | no | `bge-m3` | embedding モデル名 (1024 次元であること) |
| `DB_PATH` | no | `~/.local/share/obsidian-knowledge-mcp/index.db` | インデックス sqlite ファイル。ディレクトリは自動作成される |

## MCP ツール仕様

### search_knowledge

vector + BM25 のハイブリッド検索で関連チャンクを返す。知識ファイルの全文読みの代わりにまずこれを使う。

- 入力
  - `query: string` — 検索クエリ (日本語 / 英語)
  - `filter?: { skill?, repo?, domain?, type? }` — frontmatter 由来のメタデータで絞り込み。各 filter 値は文字列 1 つだが、判定は containment (そのノートが宣言する値集合に filter 値が含まれていればヒット) なので、`domain` を複数持つノートもいずれか一致すればヒットする
  - `top_k?: number` — 返却件数 (既定 8)
- 返却: 各ヒットの `path` / `heading` / `score` / チャンク本文。末尾に `total bytes returned: N` を付け、stderr にも返却バイト数をログする

### read_knowledge

ノート全文を返す。`search_knowledge` のチャンクで足りない場合のみ使う。

- 入力: `path: string` — `VAULT_ROOT` からの相対パスまたは絶対パス。`VAULT_ROOT` 外へのパストラバーサルは拒否する

### reindex_knowledge

mtime 差分検知を無視した強制再インデックス。

- 入力: `scope?: string` — `VAULT_ROOT` からの相対パス prefix。指定時はその配下のみ再構築する
- 返却: indexed files / chunks 数などのサマリ

## CLI での動作確認

MCP を経由せず `search_knowledge` 相当を直接叩ける。

```sh
VAULT_ROOT=/path/to/vault KNOWLEDGE_DIR=knowledge \
  npm run dev-search -- "リトライの冪等性" --top-k 5
```

`--skill` / `--repo` / `--domain` / `--type` / `--top-k` オプションを受け付ける。

## eval (golden query 評価)

`eval/golden-queries.json` に期待クエリを書き、hit@1 / hit@3 / hit@10 を計測する。

このファイルは期待する path や本文断片という形で vault 本文の抜粋を含むため gitignore してあり、リポジトリには入らない。スキーマの例として `eval/golden-queries.example.json` をコミットしてあるので、これをコピーして自分の vault に合わせて書き換える。

```sh
cp eval/golden-queries.example.json eval/golden-queries.json
VAULT_ROOT=/path/to/vault KNOWLEDGE_DIR=knowledge npm run eval
```

golden query の形式は次のとおりである。

```json
[
  {
    "query": "一覧取得のたびに関連レコードを 1 件ずつ引いてしまう",
    "filter": { "repo": "my-repo" },
    "expect_path_contains": "learnings/db",
    "expect_content_contains": "eager loading"
  }
]
```

`filter` と `expect_content_contains` は省略できる。`golden-queries.json` が存在しない場合、`npm run eval` は評価をスキップして正常終了する。

## 既知の制約

- FTS5 の trigram tokenizer は 3 文字未満の語にマッチできない。クエリは空白区切りトークンのうち 3 文字以上のものだけを OR 結合して MATCH に使うため、2 文字の日本語単語 (例: 「設定」) は BM25 側では拾えない。その場合も vector 検索側が意味的に補完する
- frontmatter は `---` 区切りブロックを `yaml` パッケージ (YAML 1.2) でパースする。ネストしたオブジェクト値は `skill` / `repo` / `domain` / `type` としては展開されず (空扱いになり警告を記録する)、YAML 構文エラーのノートは索引全体を落とさないよう frontmatter 無し扱いにフォールバックする
- `domain` などの frontmatter キーは配列で複数値を宣言できる (例: `domain: [domain-a, domain-b]`)。`search_knowledge` の filter は containment で一致判定するが、MCP ツールスキーマ上の filter 値そのものは単一文字列のみを受け付ける (配列 filter は未対応)
- インデックス DB (`DB_PATH`) は vault から常に再生成できる派生キャッシュである。内部スキーマは `PRAGMA user_version` で管理しており、バージョンが変わると `files` / `chunks` / `chunk_meta` / `vec_chunks` / `fts_chunks` を全て作り直す (再起動時に自動で再インデックスされる)。**このリポジトリのコードを旧バージョンへ戻す場合は DB ファイルの削除が必須**である。旧コードは新スキーマの `chunk_meta` テーブルを認識せず、逆に新スキーマには旧コードが期待する `chunks.skill` / `chunks.repo` / `chunks.domain` / `chunks.type` 列が存在しない
- `read_knowledge` のパス検証は正規化ベースであり、`VAULT_ROOT` 内から外部を指す symlink は検出しない
