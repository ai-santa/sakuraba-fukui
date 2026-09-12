// =============================================================
// アンケート集計（店舗オーナー向けレポートのデータ元）
// AIクチコミ v1.1 - 2026-08-23 週単位の集計を追加（今週・先週＋週別推移 byWeek）
//        v1.0 - 2026-07-26
//
// 役割：保存された回答を集計して返す。
// ・Netlify の環境変数 REPORT_KEY と URL の ?key= が一致しないと見られない
// ・REPORT_KEY が未設定のサイトでは全部拒否する（安全側）
// ・選択肢のIDのまま数えて返す。日本語ラベルへの変換は report.html 側が
//   config.js を読んで行う（＝店舗ごとの文言変更に自動追従できる）
// =============================================================

import { getStore } from "@netlify/blobs";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const JST_OFFSET = 9 * 60 * 60 * 1000;
const MAX_FREE_TEXTS = 200; // レポートに載せる自由メッセージの上限

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...CORS },
  });
}

// UTCのISO文字列 → 日本時間の Date
function toJst(iso) {
  return new Date(new Date(iso).getTime() + JST_OFFSET);
}

function ymJst(d) {
  return d.getUTCFullYear() + "-" + String(d.getUTCMonth() + 1).padStart(2, "0");
}

function ymdJst(d) {
  return ymJst(d) + "-" + String(d.getUTCDate()).padStart(2, "0");
}

// その日が属する週の月曜日（週の始まり）を返す。週は月曜始まり・日本時間基準
function mondayOf(d) {
  const dow = (d.getUTCDay() + 6) % 7; // 月曜=0 … 日曜=6
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - dow));
}

// 期間 → 「この月以降だけ数える」の境界（日本時間）と、読みにいく保存フォルダ
// 週の期間（thisWeek/lastWeek）は fromDay/toDay（日単位の境界）も返す
function periodRange(period, nowJst) {
  const y = nowJst.getUTCFullYear();
  const m = nowJst.getUTCMonth();
  const monthKey = (yy, mm) => yy + "-" + String(mm + 1).padStart(2, "0");

  if (period === "thisWeek" || period === "lastWeek") {
    const mon = mondayOf(nowJst);
    if (period === "lastWeek") mon.setUTCDate(mon.getUTCDate() - 7);
    const sun = new Date(mon);
    sun.setUTCDate(mon.getUTCDate() + 6);
    const md = (d) => (d.getUTCMonth() + 1) + "/" + d.getUTCDate();
    return {
      from: ymJst(mon),
      to: ymJst(sun),
      fromDay: ymdJst(mon),
      toDay: ymdJst(sun),
      label: (period === "thisWeek" ? "今週" : "先週") + "（" + md(mon) + "〜" + md(sun) + "）",
    };
  }
  if (period === "lastMonth") {
    const d = new Date(Date.UTC(y, m - 1, 1));
    return {
      from: monthKey(d.getUTCFullYear(), d.getUTCMonth()),
      to: monthKey(d.getUTCFullYear(), d.getUTCMonth()),
      label: monthKey(d.getUTCFullYear(), d.getUTCMonth()),
    };
  }
  if (period === "last3") {
    const d = new Date(Date.UTC(y, m - 2, 1));
    return { from: monthKey(d.getUTCFullYear(), d.getUTCMonth()), to: monthKey(y, m), label: "過去3ヶ月" };
  }
  if (period === "all") {
    return { from: "0000-00", to: "9999-99", label: "全期間" };
  }
  return { from: monthKey(y, m), to: monthKey(y, m), label: monthKey(y, m) };
}

// 数えるための入れ物
function bump(map, key) {
  if (!key) return;
  map[key] = (map[key] || 0) + 1;
}

export default async (req) => {
  if (req.method === "OPTIONS") return new Response("", { status: 204, headers: CORS });

  const url = new URL(req.url);
  const key = url.searchParams.get("key") || "";
  const expected = process.env.REPORT_KEY;

  if (!expected) {
    return json({ error: "このサイトではレポートがまだ有効になっていません（REPORT_KEY 未設定）" }, 503);
  }
  if (key !== expected) {
    return json({ error: "合言葉が違います" }, 401);
  }

  const period = url.searchParams.get("period") || "thisMonth";
  const nowJst = new Date(Date.now() + JST_OFFSET);
  const range = periodRange(period, nowJst);

  const store = getStore("responses");

  // 保存フォルダ（年月）を一覧し、対象期間の前後1ヶ月ぶんまで読む
  // （保存キーはUTC基準／集計は日本時間基準なので、月初のズレを吸収する）
  const { blobs } = await store.list();
  const targets = blobs.filter((b) => {
    const ym = String(b.key).slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(ym)) return false;
    if (range.from === "0000-00") return true;
    const prev = shiftMonth(range.from, -1);
    const next = shiftMonth(range.to, 1);
    return ym >= prev && ym <= next;
  });

  // 実データを読み込む（同時に読みすぎないよう20件ずつ）
  const records = [];
  for (let i = 0; i < targets.length; i += 20) {
    const chunk = targets.slice(i, i + 20);
    const got = await Promise.all(
      chunk.map((b) => store.get(b.key, { type: "json" }).catch(() => null))
    );
    got.forEach((r) => { if (r && r.createdAt) records.push(r); });
  }

  // 日本時間で期間内に絞る（週の期間は日単位、月の期間は月単位で判定）
  const inRange = records.filter((r) => {
    const d = toJst(r.createdAt);
    if (range.fromDay) {
      const ymd = ymdJst(d);
      return ymd >= range.fromDay && ymd <= range.toDay;
    }
    const ym = ymJst(d);
    return ym >= range.from && ym <= range.to;
  });

  // ------------------------- 集計 -------------------------
  const stats = {
    period: period,
    periodLabel: range.label,
    total: inRange.length,
    copied: 0,
    posted: 0,
    byGender: {},
    byAge: {},
    byService: {},
    byGoodPoint: {},
    byRecommendation: {},
    byStaff: {},
    byTension: {},
    byDay: {},
    byWeek: {},
    freeTexts: [],
    generatedAt: new Date().toISOString(),
  };

  inRange.forEach((r) => {
    if (r.copied) stats.copied++;
    if (r.posted) stats.posted++;
    bump(stats.byGender, r.gender);
    bump(stats.byAge, r.age);
    bump(stats.byTension, String(r.tension || 3));
    bump(stats.byDay, ymdJst(toJst(r.createdAt)));
    bump(stats.byWeek, ymdJst(mondayOf(toJst(r.createdAt))));
    (r.services || []).forEach((x) => bump(stats.byService, x));
    (r.goodPoints || []).forEach((x) => bump(stats.byGoodPoint, x));
    (r.recommendations || []).forEach((x) => bump(stats.byRecommendation, x));
    (r.staffImpressions || []).forEach((x) => bump(stats.byStaff, x));
    if (r.freeText) {
      stats.freeTexts.push({ at: r.createdAt, text: r.freeText });
    }
  });

  // 自由メッセージは新しい順
  stats.freeTexts.sort((a, b) => (a.at < b.at ? 1 : -1));
  stats.freeTexts = stats.freeTexts.slice(0, MAX_FREE_TEXTS);

  return json(stats);
};

// "2026-07" を n ヶ月ずらす
function shiftMonth(ym, n) {
  const y = parseInt(ym.slice(0, 4), 10);
  const m = parseInt(ym.slice(5, 7), 10) - 1 + n;
  const d = new Date(Date.UTC(y, m, 1));
  return d.getUTCFullYear() + "-" + String(d.getUTCMonth() + 1).padStart(2, "0");
}

export const config = { path: "/api/stats" };
