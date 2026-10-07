/**
 * 外部排片清单的解析与对账纯函数。
 * 清单常见两种形态：CSV（带表头，字段名中英混用）或 JSON 数组。
 * 对账永远以本机实拍记录为准：清单里的张数不会被当成实拍加进完成度。
 */
import type { ManifestRowInput } from '../types/manifest';
import type { TakeLog } from '../types/take';

/** 镜号归一化：去空白、全角转半角、大写（s01 与 S01 视为同一镜） */
export function normalizeShotCode(code: string): string {
  if (!code) return '';
  return code
    .replace(/[　\s]/g, '')
    .replace(/[！-～]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .toUpperCase();
}

/** 日期归一化：接受 2026-10-07 / 2026/10/07 / 2026.10.7，统一输出 YYYY-MM-DD */
export function normalizeDate(input: string): string | null {
  const raw = (input ?? '').trim();
  if (!raw) return null;
  const m = raw.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (!m) return null;
  const [, y, mo, d] = m;
  const month = Number(mo);
  const day = Number(d);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return `${y}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/* ---------------- 幂等哈希 ---------------- */

/** cyrb53：把清单内容压成稳定哈希，同一份清单（顺序无关）必然得到同一个 batchKey */
function cyrb53(str: string, seed = 0): string {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0, ch = 0; i < str.length; i++) {
    ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const h = (BigInt(h2 >>> 0) << 32n) | BigInt(h1 >>> 0);
  return h.toString(16).padStart(16, '0');
}

/**
 * 批次幂等键：条目按 镜号|日期|张数 排序后哈希。
 * 两边几乎同时提交同一份清单时键相同，唯一索引直接拦掉第二批。
 */
export function hashBatchKey(rows: ManifestRowInput[]): string {
  const lines = rows
    .map((r) => `${normalizeShotCode(r.shotCode)}|${r.plannedDate}|${Math.floor(r.plannedFrames)}`)
    .sort();
  return cyrb53(lines.join('\n'));
}

/* ---------------- CSV / JSON 解析 ---------------- */

const CODE_HEADERS = ['镜号', '镜头', '镜头编号', 'shotcode', 'shot', 'code'];
const DATE_HEADERS = ['日期', '拍摄日期', '计划日期', 'date', 'plandate', 'shotdate'];
const FRAMES_HEADERS = ['计划张数', '张数', '排出张数', 'frames', 'plannedframes', 'count', 'shots'];

function headerKey(raw: string): string {
  return normalizeShotCode(raw).replace(/[＿_]/g, '').toLowerCase();
}

function pickIndex(headers: string[], aliases: string[]): number {
  const keys = headers.map(headerKey);
  for (const alias of aliases) {
    const idx = keys.indexOf(headerKey(alias));
    if (idx >= 0) return idx;
  }
  return -1;
}

/** 轻量 CSV 行解析：支持双引号包裹与 "" 转义 */
function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuote) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuote = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuote = true;
    } else if (ch === ',') {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

export interface ParseResult {
  rows: ManifestRowInput[];
  errors: string[];
}

/** 解析清单文本：按内容自动识别 JSON 或 CSV；缺日期列时用批次日期兜底 */
export function parseManifestText(text: string, fallbackDate = ''): ParseResult {
  const errors: string[] = [];
  const body = text.replace(/^﻿/, '').trim();
  if (!body) return { rows: [], errors: ['清单为空'] };

  const looksJson = body.startsWith('[') || body.startsWith('{');
  const rawRows: Array<{ code: unknown; date: unknown; frames: unknown; line: number }> = [];

  if (looksJson) {
    let data: unknown;
    try {
      data = JSON.parse(body);
    } catch (e) {
      return { rows: [], errors: [`JSON 解析失败：${(e as Error).message}`] };
    }
    const list: unknown[] = Array.isArray(data)
      ? data
      : Array.isArray((data as Record<string, unknown>)?.items)
        ? ((data as Record<string, unknown>).items as unknown[])
        : [];
    if (!Array.isArray(list)) return { rows: [], errors: ['JSON 需为对象数组，或含 items 数组'] };
    list.forEach((obj, i) => {
      const o = (obj ?? {}) as Record<string, unknown>;
      const pick = (names: string[]) => {
        for (const n of names) {
          if (o[n] !== undefined) return o[n];
          const hit = Object.keys(o).find((k) => names.map(headerKey).includes(headerKey(k)));
          if (hit) return o[hit];
        }
        return undefined;
      };
      rawRows.push({ code: pick(CODE_HEADERS), date: pick(DATE_HEADERS), frames: pick(FRAMES_HEADERS), line: i + 1 });
    });
  } else {
    const lines = body.split(/\r?\n/).filter((l) => l.trim().length > 0);
    if (lines.length < 2) return { rows: [], errors: ['CSV 至少需要表头行和一行数据'] };
    const headers = splitCsvLine(lines[0]);
    const ci = pickIndex(headers, CODE_HEADERS);
    const di = pickIndex(headers, DATE_HEADERS);
    const fi = pickIndex(headers, FRAMES_HEADERS);
    if (ci < 0) return { rows: [], errors: ['表头缺少镜号列（可用：镜号 / shotCode）'] };
    if (fi < 0) return { rows: [], errors: ['表头缺少张数列（可用：计划张数 / frames）'] };
    lines.slice(1).forEach((line, i) => {
      const cells = splitCsvLine(line);
      rawRows.push({ code: cells[ci], date: di >= 0 ? cells[di] : '', frames: cells[fi], line: i + 2 });
    });
  }

  const rows: ManifestRowInput[] = [];
  const seen = new Set<string>();
  for (const r of rawRows) {
    const code = String(r.code ?? '').trim();
    if (!code) {
      errors.push(`第 ${r.line} 行：镜号为空，已跳过`);
      continue;
    }
    const date = normalizeDate(String(r.date ?? '')) ?? normalizeDate(fallbackDate);
    if (!date) {
      errors.push(`第 ${r.line} 行（${code}）：日期缺失或无法识别，已跳过`);
      continue;
    }
    const frames = Number(String(r.frames ?? '').trim());
    if (!Number.isFinite(frames) || frames <= 0 || Math.floor(frames) !== frames) {
      errors.push(`第 ${r.line} 行（${code}）：张数需为正整数，已跳过`);
      continue;
    }
    const dedup = `${normalizeShotCode(code)}|${date}|${frames}`;
    if (seen.has(dedup)) {
      errors.push(`第 ${r.line} 行（${code}）：与文件内另一行完全相同，已自动去重`);
      continue;
    }
    seen.add(dedup);
    rows.push({ shotCode: code, plannedDate: date, plannedFrames: frames });
  }
  return { rows, errors };
}

/* ---------------- 对账 ---------------- */

export interface ReconcileInput {
  shotCode: string;
  shotId: number | null;
  plannedDate: string;
  plannedFrames: number;
}

export interface ReconcileResult {
  status: 'matched' | 'countMismatch' | 'dateMismatch' | 'shotMissing';
  actualFrames: number | null;
  actualDate: string | null;
  note: string;
}

/**
 * 单条对账：按镜号认到本机镜头后，用本机实拍记录核对日期与张数。
 * - 镜号在本机不存在 → shotMissing
 * - 同日有实拍：张数一致 matched，否则 countMismatch（含多拍/少拍）
 * - 同日无实拍、但该镜在别的日期有记录 → dateMismatch
 * - 完全没有记录 → countMismatch（0 张，少拍）
 */
export function reconcileRow(row: ReconcileInput, takes: TakeLog[]): ReconcileResult {
  if (row.shotId === null) {
    return { status: 'shotMissing', actualFrames: null, actualDate: null, note: '本机镜头库中无此镜号' };
  }
  const mine = takes.filter((t) => t.shotId === row.shotId);
  const sameDay = mine.filter((t) => t.date === row.plannedDate);
  if (sameDay.length) {
    const actual = sameDay.reduce((sum, t) => sum + (t.takenFrames || 0), 0);
    if (actual === row.plannedFrames) {
      const onlyConfirmed = sameDay.every((t) => t.reviewStatus === 'confirmed');
      return {
        status: 'matched',
        actualFrames: actual,
        actualDate: row.plannedDate,
        note: onlyConfirmed ? '' : '对上的实拍记录尚在待复核，确认后才计入完成度',
      };
    }
    const diff = actual - row.plannedFrames;
    return {
      status: 'countMismatch',
      actualFrames: actual,
      actualDate: row.plannedDate,
      note: diff > 0 ? `多拍 ${diff} 张` : `少拍 ${Math.abs(diff)} 张`,
    };
  }
  if (mine.length) {
    const otherDates = Array.from(new Set(mine.map((t) => t.date))).sort();
    const latest = otherDates[otherDates.length - 1];
    return {
      status: 'dateMismatch',
      actualFrames: null,
      actualDate: latest,
      note: `本机记录在 ${otherDates.join('、')}，清单日期 ${row.plannedDate} 无记录`,
    };
  }
  return {
    status: 'countMismatch',
    actualFrames: 0,
    actualDate: null,
    note: `本机尚无任何实拍记录（清单计划 ${row.plannedFrames} 张）`,
  };
}
