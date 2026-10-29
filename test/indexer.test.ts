// KNOWLEDGE_DIR のカンマ区切りパースの回帰テスト

import assert from "node:assert/strict";
import { test } from "node:test";
import { getKnowledgeDirs } from "../src/indexer.js";

test("getKnowledgeDirs: カンマ区切りで複数 dir を返し、空白と空要素を除く", () => {
  process.env.KNOWLEDGE_DIR = " a/knowledge , a/wiki ,";
  assert.deepEqual(getKnowledgeDirs(), ["a/knowledge", "a/wiki"]);
});

test("getKnowledgeDirs: 未指定なら例外を投げる", () => {
  process.env.KNOWLEDGE_DIR = " , ";
  assert.throws(() => getKnowledgeDirs());
});
