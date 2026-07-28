// markdown のチャンク分割 + frontmatter 抽出
// frontmatter ブロックの切り出し (`---` 〜 `---`) は素朴な行走査で行い、
// 中身のパースは `yaml` ライブラリ (YAML 1.2 準拠) に任せる

import * as YAML from "yaml";

/** 1 チャンクの最大文字数 (約 800 token 相当)。超える場合は段落境界でさらに分割する */
const MAX_CHUNK_CHARS = 3200;

/** frontmatter からメタデータとして展開するキー */
const FRONTMATTER_KEYS = ["skill", "repo", "domain", "type"] as const;

/** チャンク分割の結果 1 件分 */
export interface Chunk {
  /** ファイル相対パス + 見出し階層を連結したパンくず */
  heading: string;
  /** チャンク本文 (見出し行を含む) */
  content: string;
  /** embedding への入力 (パンくず + 改行 + 本文) */
  embeddingInput: string;
  /** frontmatter 由来のメタデータ (key ごとに複数値を許容する) */
  meta: Record<string, string[]>;
}

/** frontmatter のパース結果 */
interface ParsedFrontmatter {
  meta: Record<string, unknown>;
  body: string;
  /** frontmatter の生 YAML テキスト (drift 検知用に tags を見るため) */
  rawMeta: Record<string, unknown>;
}

/**
 * frontmatter の値をチャンクのメタデータ用に正規化する
 * スカラは 1 要素配列、配列は各要素を文字列化、number/boolean は String()、
 * null/undefined は空配列、object (ネスト) は空配列 + 呼び出し元へ警告させる
 */
export function toValues(v: unknown): string[] {
  if (v === null || v === undefined) {
    return [];
  }
  if (Array.isArray(v)) {
    return v.map((item) => String(item));
  }
  if (typeof v === "object") {
    // ネストしたオブジェクトはメタデータとして展開できないため空扱いにする
    return [];
  }
  return [String(v)];
}

/**
 * YAML frontmatter をパースする
 * 先頭が `---` 行で始まる場合のみ、次の `---` 行までを YAML として読む
 * YAML 構文エラーは例外を投げず、frontmatter 無し扱いにフォールバックする
 * (1 本の壊れたノートで索引全体を落とさないため)
 */
function parseFrontmatter(
  raw: string,
  relativePath: string,
  warnings: string[],
): ParsedFrontmatter {
  const lines = raw.split("\n");
  if (lines[0]?.trim() !== "---") {
    return { meta: {}, body: raw, rawMeta: {} };
  }
  let closingIndex = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]?.trim() === "---") {
      closingIndex = i;
      break;
    }
  }
  if (closingIndex === -1) {
    // 閉じ区切りが無い場合は frontmatter とみなさない
    return { meta: {}, body: raw, rawMeta: {} };
  }
  const yamlText = lines.slice(1, closingIndex).join("\n");
  const body = lines.slice(closingIndex + 1).join("\n");
  try {
    const parsed = YAML.parse(yamlText) as unknown;
    if (parsed === null || parsed === undefined) {
      return { meta: {}, body, rawMeta: {} };
    }
    if (typeof parsed !== "object" || Array.isArray(parsed)) {
      warnings.push(`${relativePath}: frontmatter is not a mapping, ignored`);
      return { meta: {}, body, rawMeta: {} };
    }
    return {
      meta: parsed as Record<string, unknown>,
      body,
      rawMeta: parsed as Record<string, unknown>,
    };
  } catch (err) {
    warnings.push(
      `${relativePath}: failed to parse frontmatter as YAML (${String(err)}), treated as no frontmatter`,
    );
    return { meta: {}, body, rawMeta: {} };
  }
}

/** 見出し単位に区切った中間セクション */
interface Section {
  /** 見出し階層 (h2, h3)。ファイル冒頭のプリアンブルは空 */
  headings: string[];
  lines: string[];
}

/** 本文を `##` / `###` 見出し単位でセクションに分割する */
function splitSections(body: string): Section[] {
  const sections: Section[] = [];
  let current: Section = { headings: [], lines: [] };
  let h2: string | null = null;
  let inCodeFence = false;

  const flush = () => {
    if (current.lines.join("\n").trim() !== "") {
      sections.push(current);
    }
  };

  for (const line of body.split("\n")) {
    // コードフェンス内の `##` を見出しと誤認しないようにする
    if (/^\s*(```|~~~)/.test(line)) {
      inCodeFence = !inCodeFence;
    }
    const h2Match = !inCodeFence && /^##\s+(.+)$/.exec(line);
    const h3Match = !inCodeFence && /^###\s+(.+)$/.exec(line);
    if (h3Match) {
      flush();
      const h3 = h3Match[1]?.trim() ?? "";
      current = { headings: h2 !== null ? [h2, h3] : [h3], lines: [line] };
    } else if (h2Match) {
      flush();
      h2 = h2Match[1]?.trim() ?? "";
      current = { headings: [h2], lines: [line] };
    } else {
      current.lines.push(line);
    }
  }
  flush();
  return sections;
}

/**
 * 長すぎるテキストを段落境界 (空行) で MAX_CHUNK_CHARS 以下に分割する
 * 単一段落が上限を超える場合は文字数で強制分割する
 */
function splitLongText(text: string): string[] {
  if (text.length <= MAX_CHUNK_CHARS) {
    return [text];
  }
  const paragraphs = text.split(/\n{2,}/);
  const parts: string[] = [];
  let buffer = "";
  const flush = () => {
    if (buffer.trim() !== "") {
      parts.push(buffer);
    }
    buffer = "";
  };
  for (const paragraph of paragraphs) {
    if (paragraph.length > MAX_CHUNK_CHARS) {
      // 単一段落が上限超過: バッファを吐いてから固定長で切る
      flush();
      for (let i = 0; i < paragraph.length; i += MAX_CHUNK_CHARS) {
        parts.push(paragraph.slice(i, i + MAX_CHUNK_CHARS));
      }
      continue;
    }
    const candidate = buffer === "" ? paragraph : `${buffer}\n\n${paragraph}`;
    if (candidate.length > MAX_CHUNK_CHARS) {
      flush();
      buffer = paragraph;
    } else {
      buffer = candidate;
    }
  }
  flush();
  return parts;
}

/** tags 配列から `domain/` prefix を持つものがあるか判定する */
function hasDomainTag(rawMeta: Record<string, unknown>): boolean {
  const tags = rawMeta.tags;
  if (!Array.isArray(tags)) {
    return false;
  }
  return tags.some((tag) => typeof tag === "string" && tag.startsWith("domain/"));
}

/**
 * markdown 1 ファイルをチャンク配列に変換する
 * @param relativePath VAULT_ROOT からの相対パス (パンくずの先頭になる)
 * @param raw ファイル内容
 * @param warnings frontmatter パース時の警告を追記する配列 (呼び出し元で収集する)
 */
export function chunkMarkdown(relativePath: string, raw: string, warnings: string[] = []): Chunk[] {
  const { meta, body, rawMeta } = parseFrontmatter(raw, relativePath, warnings);

  // drift 検知: tags に domain/* があるのに domain: key が無いノートを検出する
  if (hasDomainTag(rawMeta) && meta.domain === undefined) {
    warnings.push(
      `${relativePath}: has domain/* tags but no \`domain:\` key (filter will not match)`,
    );
  }

  // frontmatter が無い / キーが無い場合は空配列にする (パスから推測しない)
  const metaColumns: Record<string, string[]> = {};
  for (const key of FRONTMATTER_KEYS) {
    const values = toValues(meta[key]);
    if (
      meta[key] !== undefined &&
      typeof meta[key] === "object" &&
      meta[key] !== null &&
      !Array.isArray(meta[key])
    ) {
      warnings.push(`${relativePath}: frontmatter key "${key}" is a nested object, ignored`);
    }
    metaColumns[key] = values;
  }

  const chunks: Chunk[] = [];
  for (const section of splitSections(body)) {
    const breadcrumb = [relativePath, ...section.headings].join(" > ");
    const sectionText = section.lines.join("\n").trim();
    for (const content of splitLongText(sectionText)) {
      const trimmed = content.trim();
      if (trimmed === "") {
        continue;
      }
      chunks.push({
        heading: breadcrumb,
        content: trimmed,
        embeddingInput: `${breadcrumb}\n${trimmed}`,
        meta: metaColumns,
      });
    }
  }
  return chunks;
}

export { FRONTMATTER_KEYS };
