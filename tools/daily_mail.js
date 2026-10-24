#!/usr/bin/env node
/**
 * 校园生活工作台 · 每日提醒邮件生成器（+ 可选发送）
 *
 * 为什么要有它：定时任务每天跑一次，如果让模型每天现拼 HTML，排版会漂移。
 * 这里把口径固化成代码——周次过滤、三块筛选、分档配色全部照 campus-workbench.html 抄，
 * 与页面预览对齐（含页面里"今天截止=金棕 / 已逾期=暗红 / 课程=鼠尾草绿"这套语义色）。
 *
 * ★ 与页面的唯一差异：**当日课表带了周次过滤**。
 *   页面 mailCourseList() 只按"今天星期几"挑课，不管这门课本学期第几周上不上；
 *   本脚本按学期锚点算出今天第几周，weeks 不含该周则跳过（页面那条待改）。
 *
 * 用法：
 *   node tools/daily_mail.js --data data.json --out mail.html   # 只生成，不发送
 *   node tools/daily_mail.js --data data.json --send            # 生成并发送
 *   node tools/daily_mail.js --data data.json --today 2026-10-20 # 覆盖日期（排期预演 / 测试用）
 *
 * data.json 结构（云表列名原样塞进来即可）：
 * {
 *   "today": "2026-10-13",              // 可省略，默认取本机今天
 *   "semStart": "2026-08-31",           // 第 1 周周一，可省略走默认
 *   "remind": {
 *     "email": "", "pushTime": "08:00", "advanceDays": 7,
 *     "daily": true,                    // 每日 DDL 汇总推送 —— false ⇒ 整封不发（返回 skipped）
 *     "countdown": true,                // 截止倒计时提醒 —— false ⇒ 块一只留今天与逾期
 *     "mile": true                      // 长任务节点提醒 —— false ⇒ 块三整块不出现
 *   },
 *   "ddls":    [ { name, course, due_at, submit_method, status } ],
 *   "courses": [ { name, day, slot, exact_slot, location, teacher, weeks } ],
 *   "stages":  [ { total_task, stage_name, deliverable, planned_start, planned_end, status } ]
 * }
 *
 * 三个开关与「提前提醒天数」都会真的生效（2026-10-14 前它们只是摆设，脚本不读）：
 *   · daily=false      → 不发信，composeMail 返回 { skipped:true, reason }，CLI 退出码 0
 *   · countdown=false  → DDL 窗口收到 0，块一只列「今天到期」（逾期归块〇）
 *   · countdown=true   → DDL 窗口 = advanceDays（缺省 7，上限 30）
 *   · mile=false       → 块三（含其「已落后计划」子块）整块不渲染
 *   块二（当日课表）随信必发，它是这封邮件的主体。
 *
 * 块序（2026-10-15 起）：〇 逾期未完成 → 一 DDL 倒计时 → 二 当日课表 → 三 今日该推进的长任务阶段
 *   · 块〇**有逾期才出现**（逾期混在「未来 N 天」里最容易被跳过）
 *   · 块三末尾的「已落后计划」子块**有落后的才出现**（这类阶段计划窗已关，
 *     既不在「正在推进」也不在「即将开始」里，不单列就会从信里彻底消失）
 *
 * 纯函数全部导出，回归脚本 tmp_verify/verify_daily_mail.js 直接 import 调用
 * （沙箱禁止进程内再 spawn，所以测试不走子进程）。
 */

import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/* ======================= 常量（照抄页面） ======================= */

export const SEM_WEEKS = 20;
export const SEM_START_DEFAULT = '2026-08-31';
/* 「提前提醒天数」未配置时的缺省：7 天（= 改造前的固定窗口，保证行为不回退） */
export const DEFAULT_AHEAD = 7;
export const AHEAD_MAX = 30;
/* 长任务「即将开始」的预告窗口，独立于提醒设置（阶段跨度长，窗口不该随 DDL 设置收缩） */
export const PLAN_HORIZON = 7;
export const DAYS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
export const BLOCK_OVERDUE = '逾期未完成';
export const BLOCK_DDL = 'DDL 倒计时';
export const BLOCK_COURSE = '当日课表';
export const BLOCK_PLAN = '今日该推进的长任务阶段';
export const BLOCK_LAG = '已落后计划';
export const MAIL_BLOCKS = [BLOCK_DDL, BLOCK_COURSE, BLOCK_PLAN];

/* —— 「非课程任务」——
   任务不一定属于课程：班务、评奖评优、困难认定、报名、体检、讲座签到……
   这些任务的 course 是空的（或人写了个「无」）。邮件里不要印成「未归类」
   （那读起来像漏填），统一显示成「非课程任务」。
   注意：**只影响邮件文案，库里存的值一个字都不改**；口径与页面 courseLabel 一致。 */
export const NON_COURSE_TAG = '非课程任务';
export const NON_COURSE_ALIAS = ['无', '没有', '暂无', '无课程', '无相关课程', '非课程', '非课程任务', '班务', '其他'];
export function courseLabel(v) {
  const s = String(v === null || v === undefined ? '' : v).trim();
  return (!s || NON_COURSE_ALIAS.indexOf(s) >= 0) ? NON_COURSE_TAG : s;
}

/* 块一标题随提醒窗口变化。逾期项已单独提为块〇，所以关掉倒计时后这里只剩「今天到期」 */
export function ddlBlockTitle(horizon) {
  const n = Number(horizon) || 0;
  return BLOCK_DDL + '（' + (n > 0 ? ('未来 ' + n + ' 天') : '今天到期') + '）';
}

export const overdueBlockTitle = (n) => BLOCK_OVERDUE + '（' + n + ' 项）';

/* 12 小节 → 7 段；slot 与时间段单点派生 */
export const PERIOD_RANGES = [
  { a: 1, b: 2, from: '08:30', to: '10:05', slot: '第1-2节' },
  { a: 3, b: 4, from: '10:20', to: '11:55', slot: '第3-4节' },
  { a: 5, b: 6, from: '14:30', to: '16:05', slot: '第5-6节' },
  { a: 7, b: 8, from: '16:20', to: '17:55', slot: '第7-8节' },
  { a: 9, b: 10, from: '19:30', to: '21:05', slot: '第9-10节' },
  { a: 11, b: 11, from: '21:10', to: '21:55', slot: '第11节' },
  { a: 12, b: 12, from: '22:00', to: '22:30', slot: '第12节' },
];
export const SLOTS = [];
PERIOD_RANGES.forEach((r) => { if (r.slot && SLOTS.indexOf(r.slot) < 0) SLOTS.push(r.slot); });
export const SLOT_HINT = {};
PERIOD_RANGES.forEach((r) => { if (r.slot) SLOT_HINT[r.slot] = r.from + '-' + r.to; });

/* 配色 —— 与页面 campus-workbench.html 的 :root 及 .mail-tag.* 逐字对齐。
   ★ 改页面配色时必须同步这里，否则「页面预览」与「真实邮件」会分裂。 */
export const C = {
  bg: '#f4f5f7', paper: '#ffffff', paper2: '#eef0f3',
  line: '#e4e7ec', line2: '#d5d9e0',
  ink: '#17181b', ink2: '#4b4f57', ink3: '#8a909c',
  brand: '#e23b2e', accent: '#ff7a1a', sage: '#2e7d5b', plum: '#6b4b8a',
  overBg: '#fdeaea', overFg: '#c22a1e',
  todayBg: '#fdf0dc', todayFg: '#9a5e08',
  soonBg: '#e6f3ee', soonFg: '#236045',
  planBg: '#f1ebf8', planFg: '#54396b',
};

/* ======================= 小工具 ======================= */

export const pad2 = (n) => (n < 10 ? '0' : '') + n;

export function esc(s) {
  return String(s === null || s === undefined ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/* 只取字面 Y-M-D-H:M，不做时区换算（与页面 parseDate 同口径） */
export function parseDate(v) {
  if (v instanceof Date) return isNaN(v.getTime()) ? null : v;
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (!s) return null;
  const m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ](\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?/);
  if (!m) return null;
  return new Date(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
}

export const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
export const dayDiff = (a, b) => Math.round((startOfDay(a) - startOfDay(b)) / 86400000);
export const dowIndex = (d) => (d.getDay() === 0 ? 6 : d.getDay() - 1);
export const fmtDateFull = (d) => d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
export const fmtDate = (d) => (d.getMonth() + 1) + '月' + d.getDate() + '日';

export function fmtDateTime(d) {
  const base = fmtDateFull(d);
  return (d.getHours() || d.getMinutes()) ? base + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes()) : base;
}

export function weekMonday(d) {
  const day = dowIndex(d);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - day);
}
export function weekOfDate(d, semStart) {
  const mon = weekMonday(d);
  const diff = Math.round((mon - semStart) / 86400000);
  return Math.floor(diff / 7) + 1;
}

/* ======================= 周次解析（照抄页面） ======================= */

export function appendRange(arr, a, b) {
  for (let i = 0; i < arr.length; i++) {
    if (b < arr[i][0] - 1 || a > arr[i][1] + 1) continue;
    arr[i][0] = Math.min(arr[i][0], a);
    arr[i][1] = Math.max(arr[i][1], b);
    return;
  }
  arr.push([a, b]);
  arr.sort((x, y) => x[0] - y[0]);
}

export function weeksParse(text) {
  const raw = String(text === null || text === undefined ? '' : text).trim();
  const out = { raw, all: false, odd: false, even: false, ranges: [], excl: [], unknown: false };
  if (!raw) { out.all = true; return out; }
  if (/停课|放假|调休/.test(raw)) { out.all = true; return out; }

  let s = raw.replace(/（/g, '(').replace(/）/g, ')');
  s = s.replace(/[A-Za-z]{1,4}-?\d{2,6}/g, ' ');                                  // 剔课程代码 C224
  s = s.replace(/(楼|室|馆|中心|机房|校区|操场|体育场|报告厅)[^\s,，、;；]{0,12}/g, ' ');

  const inner = [];
  s = s.replace(/\(([^()]*)\)/g, (m, g) => { inner.push(g); return ' '; });
  const innerTxt = inner.join(' ');

  /* 排除周必须**分别**扫括号内与外层，拼成一句会把后面的区间当排除项 */
  function scanExcl(text) {
    String(text || '').replace(/[除不含]{1,2}\s*([^;；]{0,32})/g, (m, g) => {
      const re = /(\d{1,2})\s*(?:[-~—－–至到]\s*(\d{1,2}))?/g;
      let mm;
      while ((mm = re.exec(String(g)))) {
        const a = +mm[1];
        let b = mm[2] ? +mm[2] : a;
        if (a < 1 || a > SEM_WEEKS) continue;
        if (b > a) b = Math.min(b, SEM_WEEKS);
        for (let n = a; n <= b; n++) if (out.excl.indexOf(n) < 0) out.excl.push(n);
      }
      return m;
    });
  }
  scanExcl(innerTxt);
  scanExcl(s);

  const probe = innerTxt + ' ' + s;
  if (/单周|奇数周|单数周/.test(probe) || /(^|[\s,，、])单([\s,，、]|$)/.test(probe)) out.odd = true;
  if (/双周|偶数周|双数周/.test(probe) || /(^|[\s,，、])双([\s,，、]|$)/.test(probe)) out.even = true;

  const re2 = /(\d{1,2})\s*(?:[-~—－–至到]\s*(\d{1,2}))?/g;
  let m2;
  while ((m2 = re2.exec(s))) {
    let x = +m2[1];
    let y = m2[2] ? +m2[2] : x;
    if (x < 1 || x > 30) continue;
    if (y < x) { const t = x; x = y; y = t; }
    if (y > 30) y = SEM_WEEKS;
    appendRange(out.ranges, x, y);
  }
  if (!out.ranges.length && !out.odd && !out.even) out.unknown = true;
  return out;
}

export function weeksHit(p, w) {
  if (!p) return true;
  if (p.all) return true;
  if (p.odd && w % 2 === 0) return false;
  if (p.even && w % 2 === 1) return false;
  if (!p.ranges.length) return true;                 // 认不出 → 照常显示，不漏课
  let hit = false;
  for (let i = 0; i < p.ranges.length; i++) {
    if (w >= p.ranges[i][0] && w <= p.ranges[i][1]) { hit = true; break; }
  }
  if (!hit) return false;
  if (p.excl && p.excl.indexOf(w) >= 0) return false;
  return true;
}

export function slotRank(s) {
  const i = SLOTS.indexOf(s);
  return i >= 0 ? i : 99;
}

export const tagText = (diff) => (diff < 0 ? '已逾期 ' + Math.abs(diff) + ' 天' : (diff === 0 ? '今天截止' : diff + ' 天后'));

/* ======================= 三块内容 ======================= */

/* DDL 行字段映射（块〇与块一共用，保证两处口径一致） */
function ddlRow(d, due, diff) {
  return {
    name: String(d.name || '').trim() || '未命名任务',
    course: courseLabel(d.course),
    due: fmtDateTime(due),
    method: (d.submit_method && d.submit_method !== '待确认') ? d.submit_method : '',
    diff,
  };
}

/* horizon = 往前看几天（0 ⇒ 只留今天截止与已逾期）；逾期（负数）永久保留 */
export function buildDdlList(ddls, today, horizon) {
  const h = (horizon === undefined || horizon === null) ? DEFAULT_AHEAD : Number(horizon);
  const win = isFinite(h) && h > 0 ? Math.round(h) : 0;
  const out = [];
  (ddls || []).forEach((d) => {
    if (String(d.status || '').trim() === '已完成') return;
    const due = parseDate(d.due_at);
    if (!due) return;                                 // 没填截止时间的不进倒计时
    const diff = dayDiff(due, today);
    if (diff > win) return;
    out.push(ddlRow(d, due, diff));
  });
  out.sort((a, b) => a.diff - b.diff);
  return out;
}

/* 块〇 · 逾期未完成：未完成 + 截止日已过。从块一里提出来单独置顶
   （逾期的事最容易被漏掉，混在「未来 N 天」里不显眼） */
export function buildOverdueList(ddls, today) {
  const out = [];
  (ddls || []).forEach((d) => {
    if (String(d.status || '').trim() === '已完成') return;
    const due = parseDate(d.due_at);
    if (!due) return;
    const diff = dayDiff(due, today);
    if (diff >= 0) return;
    out.push(ddlRow(d, due, diff));
  });
  out.sort((a, b) => a.diff - b.diff);
  return out;
}

export function buildCourseList(courses, today, weekNo) {
  const di = dowIndex(today);
  return (courses || [])
    .filter((c) => DAYS.indexOf(String(c.day || '').trim()) === di)
    .filter((c) => weeksHit(weeksParse(c.weeks), weekNo))   // ★ 页面缺的那一步
    .sort((a, b) => slotRank(a.slot) - slotRank(b.slot))
    .map((c) => ({
      name: String(c.name || '').trim() || '未命名课程',
      when: c.exact_slot ? (c.slot + '（' + c.exact_slot + '）') : String(c.slot || ''),
      hint: SLOT_HINT[String(c.slot || '')] || '',
      place: String(c.location || '').trim(),
      teacher: String(c.teacher || '').trim(),
    }));
}

export function buildPlanList(stages, today) {
  const out = [];
  (stages || []).forEach((p) => {
    if (String(p.status || '').trim() !== '进行中') return;
    const st = parseDate(p.planned_start);
    const en = parseDate(p.planned_end);
    if (!st && !en) return;
    const s = st ? dayDiff(st, today) : -9999;
    const e = en ? dayDiff(en, today) : 9999;
    if (s <= 0 && e >= 0) out.push({ row: p, kind: 'active' });
    else if (s > 0 && s <= PLAN_HORIZON) out.push({ row: p, kind: 'soon' });
  });
  out.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'active' ? -1 : 1;
    const as = parseDate(a.row.planned_start), bs = parseDate(b.row.planned_start);
    return (as ? as.getTime() : 0) - (bs ? bs.getTime() : 0);
  });
  return out.map((x) => ({
    task: String(x.row.total_task || '').trim() || '未命名长任务',
    stage: String(x.row.stage_name || '').trim() || '未命名阶段',
    deliv: String(x.row.deliverable || '').trim(),
    start: parseDate(x.row.planned_start) ? fmtDate(parseDate(x.row.planned_start)) : '未定',
    end: parseDate(x.row.planned_end) ? fmtDate(parseDate(x.row.planned_end)) : '未定',
    kind: x.kind,
  }));
}

/* 块三子块 · 已落后计划：未完成、且计划结束日已过。
   这类阶段**既不在「正在推进」也不在「即将开始」里**（计划窗已关），
   不加这一块就会从邮件里彻底消失 —— 而那正是最该被提醒的。 */
export function buildLagList(stages, today) {
  const out = [];
  (stages || []).forEach((p) => {
    if (String(p.status || '').trim() === '已完成') return;
    const en = parseDate(p.planned_end);
    if (!en) return;
    const late = dayDiff(today, en);                  // 已超过计划结束日几天
    if (late <= 0) return;
    out.push({
      task: String(p.total_task || '').trim() || '未命名长任务',
      stage: String(p.stage_name || '').trim() || '未命名阶段',
      deliv: String(p.deliverable || '').trim(),
      end: fmtDate(en),
      late,
    });
  });
  out.sort((a, b) => b.late - a.late);
  return out;
}

/* ======================= 渲染 HTML ======================= */

function tagSpan(text, kind) {
  const map = {
    over: [C.overBg, C.overFg], today: [C.todayBg, C.todayFg],
    soon: [C.soonBg, C.soonFg], plan: [C.planBg, C.planFg],
  };
  const [bg, fg] = map[kind] || map.soon;
  return '<span style="display:inline-block;font-size:11px;font-weight:600;border-radius:999px;padding:1px 8px;'
    + 'margin-left:5px;white-space:nowrap;background:' + bg + ';color:' + fg + ';">' + esc(text) + '</span>';
}

function itemCard(accent, line1, line2) {
  return '<div style="padding:11px 13px;background:' + C.paper2 + ';border-radius:0;border-left:3px solid '
    + accent + ';margin-bottom:8px;font-size:13px;color:' + C.ink + ';line-height:1.7;">' + line1
    + (line2 ? ('<div style="font-size:12px;color:' + C.ink3 + ';margin-top:3px;">' + line2 + '</div>') : '')
    + '</div>';
}

const sectionTitle = (text) => '<div style="font-size:14px;color:' + C.ink + ';font-weight:600;margin-bottom:10px;">' + esc(text) + '</div>';
const noneLine = (text) => '<div style="font-size:13px;color:' + C.ink3 + ';padding:0 0 3px 2px;">' + esc(text) + '</div>';

export function renderHtml(p) {
  const h = [];
  const overdue = p.overdue || [];     // 兼容手工构造的 p（早期调用方没有这两项）
  const lag = p.lag || [];
  h.push('<!DOCTYPE html>');
  h.push('<html lang="zh-CN">');
  h.push('<head><meta charset="utf-8">');
  h.push('<meta name="viewport" content="width=device-width, initial-scale=1">');
  h.push('<title>' + esc(p.subject) + '</title></head>');
  h.push('<body style="margin:0;padding:0;background:' + C.bg + ';">');
  h.push('<div style="margin:0;padding:24px 12px;background:' + C.bg
    + ";font-family:-apple-system,'PingFang SC','Microsoft YaHei',sans-serif;\">");
  h.push('<div style="max-width:580px;margin:0 auto;background:' + C.paper + ';border:1px solid ' + C.line
    + ';border-radius:0;overflow:hidden;">');

  /* 标题条 —— 左侧红竖条与页面导航卡片的「左竖条高亮」同一套语言 */
  h.push('<div style="padding:16px 20px;background:' + C.paper2 + ';border-bottom:1px solid ' + C.line
    + ';border-left:3px solid ' + C.brand + ';">');
  h.push('<div style="font-size:15px;color:' + C.ink + ';font-weight:600;line-height:1.55;">' + esc(p.subject) + '</div>');
  h.push('<div style="font-size:12px;color:' + C.ink3 + ';margin-top:6px;">收件人：'
    + esc(p.to || '未设置') + ' · 推送时间 ' + esc(p.at) + ' · '
    + esc(p.countdown ? ('提前 ' + p.ahead + ' 天提醒') : '仅提醒当天与逾期') + '</div>');
  h.push('</div>');

  h.push('<div style="padding:20px;">');

  /* 〇 —— 逾期项单独置顶。混在「未来 N 天」里最容易被眼睛跳过，而它恰恰是最该处理的 */
  if (overdue.length) {
    h.push('<div style="margin-bottom:20px;">');
    h.push(sectionTitle('〇、' + overdueBlockTitle(overdue.length)));
    overdue.forEach((d) => {
      h.push(itemCard(C.overFg,
        '<b>' + esc(d.name) + '</b>（' + esc(d.course) + '）— ' + esc(d.due) + tagSpan(tagText(d.diff), 'over'),
        d.method ? esc(d.method) : ''));
    });
    h.push('</div>');
  }

  /* 一 */
  h.push('<div style="margin-bottom:20px;">');
  h.push(sectionTitle('一、' + ddlBlockTitle(p.horizon)));
  if (p.ddl.length) {
    p.ddl.forEach((d) => {
      const kind = d.diff < 0 ? 'over' : (d.diff === 0 ? 'today' : 'soon');
      const accent = d.diff < 0 ? C.overFg : (d.diff === 0 ? C.todayFg : C.sage);
      h.push(itemCard(accent,
        '<b>' + esc(d.name) + '</b>（' + esc(d.course) + '）— ' + esc(d.due) + tagSpan(tagText(d.diff), kind),
        d.method ? esc(d.method) : ''));
    });
  } else {
    h.push(noneLine(p.horizon > 0
      ? ('未来 ' + p.horizon + ' 天内没有待提交的任务。')
      : '今天没有截止的任务。'));
  }
  h.push('</div>');

  /* 二 */
  h.push('<div style="margin-bottom:20px;">');
  h.push(sectionTitle('二、' + MAIL_BLOCKS[1] + '（' + DAYS[dowIndex(p.date)] + ' · 第 ' + p.weekNo + ' 周）'));
  if (p.courses.length) {
    p.courses.forEach((c) => {
      const meta = [c.hint, c.place, c.teacher].filter(Boolean).map(esc).join(' · ');
      h.push(itemCard(C.sage, '<b>' + esc(c.when) + '</b> ' + esc(c.name), meta));
    });
  } else {
    h.push(noneLine('今天没有课。'));
  }
  h.push('</div>');

  /* 三 —— 长任务节点提醒关掉时整块不出现（用户主动关的，不必在信里再提醒一遍） */
  if (p.planOn) {
    h.push('<div style="margin-bottom:20px;">');
    h.push(sectionTitle('三、' + BLOCK_PLAN));
    if (p.plans.length) {
      p.plans.forEach((s) => {
        const head = tagSpan(s.kind === 'active' ? '正在推进' : '即将开始', 'plan')
          + '<b>' + esc(s.task) + '</b> · ' + esc(s.stage) + '（' + esc(s.start) + ' ~ ' + esc(s.end) + '）';
        h.push(itemCard(C.plum, head, s.deliv ? '交付物：' + esc(s.deliv) : ''));
      });
    } else if (!lag.length) {
      h.push(noneLine('今天没有需要推进的长任务阶段。'));
    }
    /* 已落后：这些阶段计划窗已关，既不属于「正在推进」也不属于「即将开始」，
       不单列就会从信里彻底消失 */
    if (lag.length) {
      h.push('<div style="font-size:12.5px;color:' + C.overFg + ';font-weight:600;margin:12px 0 8px 2px;">'
        + '⚠ ' + esc(BLOCK_LAG) + '（' + lag.length + ' 个阶段）</div>');
      lag.forEach((s) => {
        h.push(itemCard(C.overFg,
          '<b>' + esc(s.task) + '</b> · ' + esc(s.stage) + tagSpan('已过 ' + s.late + ' 天', 'over'),
          '计划 ' + esc(s.end) + ' 结束' + (s.deliv ? (' · 交付物：' + esc(s.deliv)) : '')));
      });
    }
    h.push('</div>');
  }

  /* 页脚 */
  h.push('<div style="margin-top:22px;padding-top:14px;border-top:1px dashed ' + C.line2
    + ';font-size:11.5px;color:' + C.ink3 + ';line-height:1.75;">由「校园生活工作台」自动生成 · '
    + esc(fmtDateFull(p.date)) + ' ' + DAYS[dowIndex(p.date)] + ' 第 ' + p.weekNo + ' 周<br>'
    + esc(p.footNote || '定时任务自动推送') + '</div>');

  h.push('</div></div></div></body></html>');
  return h.join('\n');
}

/* ======================= 组装（可导入的入口） ======================= */

const DEFAULT_TO = '';   // 交付版留空：由 remind_settings 里的邮箱决定

/* 开关取值：缺省按 dft；字符串（定时任务手写 JSON 时常见）也认 */
export function boolOf(v, dft) {
  if (v === undefined || v === null || v === '') return !!dft;
  if (typeof v === 'string') return !/^(false|0|no|off|否|关|关闭)$/i.test(v.trim());
  return !!v;
}

/**
 * @param {object} data 见文件头结构说明
 * @param {object} [opts] { today: 'YYYY-MM-DD', footNote: string }
 * @returns {{skipped?:boolean, reason?:string, html, subject, to, at, ahead, weekNo, date, horizon, counts, parts}}
 */
export function composeMail(data, opts = {}) {
  if (typeof data !== 'object' || data === null) throw new Error('data 不是对象');
  ['ddls', 'courses', 'stages'].forEach((k) => {
    if (data[k] !== undefined && !Array.isArray(data[k])) throw new Error('data.' + k + ' 必须是数组');
  });

  const semStart = parseDate(data.semStart) || parseDate(SEM_START_DEFAULT);
  if (!semStart) throw new Error('学期锚点解析失败');

  const todaySrc = opts.today !== undefined ? opts.today : data.today;
  const todayParsed = parseDate(todaySrc);
  const today = todayParsed ? startOfDay(todayParsed) : startOfDay(new Date());

  const weekNo = weekOfDate(today, semStart);
  const remind = data.remind || {};
  const to = String(remind.email || '').trim() || DEFAULT_TO;
  const at = String(remind.pushTime || '08:00').trim() || '08:00';

  let ahead = (remind.advanceDays === undefined || remind.advanceDays === null || remind.advanceDays === '')
    ? DEFAULT_AHEAD : Number(remind.advanceDays);
  if (!isFinite(ahead)) ahead = DEFAULT_AHEAD;
  ahead = Math.min(AHEAD_MAX, Math.max(0, Math.round(ahead)));

  /* 三个开关（缺省 true，与云表列默认一致） */
  const dailyOn = boolOf(remind.daily, true);        // 每日 DDL 汇总推送 = 整封邮件的总开关
  const countdownOn = boolOf(remind.countdown, true); // 截止倒计时提醒 = 块一的提醒窗口
  const mileOn = boolOf(remind.mile, true);          // 长任务节点提醒 = 块三是否出现

  const flags = { daily: dailyOn, countdown: countdownOn, mile: mileOn, horizon: countdownOn ? ahead : 0 };

  if (!dailyOn) {
    return {
      skipped: true,
      reason: '「每日 DDL 汇总推送」已关闭，今天不发信',
      html: '', subject: '', to, at, ahead, weekNo,
      date: fmtDateFull(today), horizon: 0, flags,
      counts: { ddl: 0, overdue: 0, courses: 0, plans: 0, lag: 0 },
      parts: { ddl: [], overdue: [], courses: [], plans: [], lag: [] },
    };
  }

  const overdue = buildOverdueList(data.ddls, today);
  const ddl = buildDdlList(data.ddls, today, flags.horizon).filter((d) => d.diff >= 0);
  const courses = buildCourseList(data.courses, today, weekNo);
  const plans = mileOn ? buildPlanList(data.stages, today) : [];
  const lag = mileOn ? buildLagList(data.stages, today) : [];

  const p = {
    date: today, to, at, ahead, weekNo,
    horizon: flags.horizon, countdown: countdownOn, planOn: mileOn,
    ddl, overdue, courses, plans, lag,
    footNote: opts.footNote || '定时任务自动推送',
  };
  const dueCount = overdue.length + ddl.length;
  p.subject = '【校园生活工作台】' + fmtDateFull(today) + ' ' + DAYS[dowIndex(today)] + ' · 今日提醒'
    + (dueCount ? ('（' + dueCount + ' 项待办）') : '');

  return {
    skipped: false,
    html: renderHtml(p),
    subject: p.subject,
    to, at, ahead,
    weekNo,
    date: fmtDateFull(today),
    horizon: flags.horizon,
    flags,
    counts: { ddl: ddl.length, overdue: overdue.length, courses: courses.length, plans: plans.length, lag: lag.length },
    parts: { ddl, overdue, courses, plans, lag },
  };
}

/* ======================= CLI ======================= */

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isMain) {
  const argv = process.argv.slice(2);
  const argOf = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };

  if (argv.includes('--help') || argv.includes('-h')) {
    console.log('用法：node tools/daily_mail.js --data <data.json> [--out <mail.html>] [--send] [--today YYYY-MM-DD] [--foot "页脚说明"]');
    process.exit(0);
  }

  const dataPath = argOf('--data');
  if (!dataPath) { console.error('[FAIL] 缺少 --data <data.json>'); process.exit(2); }

  let data;
  try { data = JSON.parse(readFileSync(resolve(dataPath), 'utf8')); }
  catch (e) { console.error('[FAIL] 读取或解析 data.json 失败：' + e.message); process.exit(2); }

  let mail;
  try {
    mail = composeMail(data, { today: argOf('--today'), footNote: argOf('--foot') });
  } catch (e) { console.error('[FAIL] ' + e.message); process.exit(2); }

  /* 总开关关掉 ⇒ 今天不发信。这不算失败，退出码 0，也不写 --out */
  if (mail.skipped) {
    console.log('[SKIP] ' + mail.reason);
    console.log('SUMMARY ' + JSON.stringify({
      skipped: true, to: mail.to, weekNo: mail.weekNo, date: mail.date, counts: mail.counts,
    }));
    process.exit(0);
  }

  const outPath = argOf('--out');
  if (outPath) {
    writeFileSync(resolve(outPath), mail.html, 'utf8');
    console.log('[OK] 已生成 ' + resolve(outPath));
  }

  const summary = {
    to: mail.to, subject: mail.subject, weekNo: mail.weekNo, date: mail.date, counts: mail.counts,
  };

  if (!argv.includes('--send')) {
    if (!outPath) process.stdout.write(mail.html);
    console.error('[INFO] 未加 --send，仅生成。\n' + JSON.stringify(summary));
    process.exit(0);
  }

  /* ---- 发送 ---- */
  const CRED_FILE = join(homedir(), '.workbuddy', 'qq-mail-credentials.json');
  let cred = null;
  const envA = (process.env.QQ_EMAIL_ACCOUNT || '').trim();
  const envC = (process.env.QQ_EMAIL_AUTH_CODE || '').trim();
  if (envA && envC) cred = { account: envA, authCode: envC, from: 'env' };
  else if (existsSync(CRED_FILE)) {
    try {
      const j = JSON.parse(readFileSync(CRED_FILE, 'utf8'));
      const a = String(j.account || '').trim(), c = String(j.authCode || '').trim();
      if (a && c) cred = { account: a, authCode: c, from: 'file' };
      else { console.error('[FAIL] 凭证文件里 account / authCode 为空：' + CRED_FILE); process.exit(2); }
    } catch (e) { console.error('[FAIL] 凭证文件解析失败：' + e.message); process.exit(2); }
  }
  if (!cred) { console.error('[FAIL] 找不到邮箱凭证（环境变量或 ' + CRED_FILE + '）'); process.exit(2); }

  let nodemailer;
  try {
    const req = createRequire(join(homedir(), '.workbuddy', 'skills', 'qq-email', 'package.json'));
    nodemailer = req('nodemailer');
  } catch (e) { console.error('[FAIL] 无法加载 nodemailer：' + e.message); process.exit(3); }

  const text = mail.html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(div|p|tr|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/\n{3,}/g, '\n\n').trim();

  const transporter = nodemailer.createTransport({
    host: 'smtp.qq.com', port: 465, secure: true,
    auth: { user: cred.account, pass: cred.authCode },
  });

  transporter.sendMail({
    from: '"校园生活工作台" <' + cred.account + '>',
    to: mail.to, subject: mail.subject, text, html: mail.html,
  }).then((info) => {
    console.log('[OK] 已发送');
    console.log('messageId: ' + info.messageId);
    console.log('收件人  : ' + mail.to);
    console.log('主题    : ' + mail.subject);
    console.log('凭证来源: ' + cred.from);
    console.log('SUMMARY ' + JSON.stringify(summary));
  }).catch((e) => {
    console.error('[FAIL] 发送失败：' + (e && e.message ? e.message : String(e)));
    if (e && e.response) console.error('       SMTP 响应：' + e.response);
    process.exit(1);
  });
}
