// =============================================================
// アンケート回答の保存（Netlify Blobs）
// AIクチコミ v1.0 - 2026-07-26
//
// 役割：review.html でお客様が答えた内容を1件ずつ保存する。
// ・お客様の氏名・メール等は元々受け取っていない（保存もしない）
// ・同じ人が「作り直す」を押しても1件のまま（idで上書き）
// ・この関数が落ちても、お客様のクチコミ作成は絶対に止めない
//   （review.html 側で握りつぶしている）
// =============================================================

import { getStore } from "@netlify/blobs";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const MAX_FREE_TEXT = 2000;   // 自由メッセージの保存上限（文字）
const MAX_ARRAY = 50;         // 選択肢配列の上限（いたずら対策）

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}

// 文字列の安全化（型が違うものは捨てる）
function str(v, max) {
  if (typeof v !== "string") return "";
  return v.slice(0, max);
}

// 配列の安全化（文字列だけ・件数制限）
function arr(v) {
  if (!Array.isArray(v)) return [];
  return v.filter((x) => typeof x === "string").slice(0, MAX_ARRAY).map((x) => x.slice(0, 100));
}

// id を発行する（例: 20260726-143052-a4f9）
// 先頭8桁が日付なので、id だけで保存先の年月フォルダが分かる
function newId(now) {
  const p = (n) => String(n).padStart(2, "0");
  const d =
    now.getUTCFullYear() +
    p(now.getUTCMonth() + 1) +
    p(now.getUTCDate()) +
    "-" +
    p(now.getUTCHours()) +
    p(now.getUTCMinutes()) +
    p(now.getUTCSeconds());
  const rand = Math.random().toString(16).slice(2, 6);
  return d + "-" + rand;
}

// id → 保存キー（"2026-07/20260726-143052-a4f9"）
function keyOf(id) {
  if (!/^\d{8}-\d{6}-[0-9a-f]{4}$/.test(id)) return null;
  return id.slice(0, 4) + "-" + id.slice(4, 6) + "/" + id;
}

export default async (req) => {
  if (req.method === "OPTIONS") return new Response("", { status: 204, headers: CORS });
  if (req.method !== "POST") return json({ error: "Method Not Allowed" }, 405);

  let body;
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid json" }, 400);
  }

  const store = getStore("responses");
  const now = new Date();

  // ------- 既存レコードの更新（コピーした／Googleへ進んだ の記録） -------
  const givenId = typeof body.id === "string" ? body.id : "";
  if (givenId) {
    const key = keyOf(givenId);
    if (!key) return json({ error: "invalid id" }, 400);

    const prev = await store.get(key, { type: "json" });
    if (!prev) return json({ error: "not found" }, 404);

    // 更新できるのはこの2つのフラグと、作り直しによる回答内容のみ
    const next = {
      ...prev,
      copied: prev.copied || body.copied === true,
      posted: prev.posted || body.posted === true,
      regenerated: (prev.regenerated || 0) + (body.regenerated ? 1 : 0),
      tension: Number.isInteger(body.tension) ? body.tension : prev.tension,
      updatedAt: now.toISOString(),
    };
    await store.setJSON(key, next);
    return json({ ok: true, id: givenId });
  }

  // ------------------- 新規レコードの作成 -------------------
  const id = newId(now);
  const record = {
    id,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    gender: str(body.gender, 20),
    age: str(body.age, 20),
    tension: Number.isInteger(body.tension) ? body.tension : 3,
    services: arr(body.services),
    goodPoints: arr(body.goodPoints),
    recommendations: arr(body.recommendations),
    staffImpressions: arr(body.staffImpressions),
    freeText: str(body.freeText, MAX_FREE_TEXT),
    copied: false,
    posted: false,
    regenerated: 0,
  };

  await store.setJSON(keyOf(id), record);
  return json({ ok: true, id });
};

export const config = { path: "/api/save" };
