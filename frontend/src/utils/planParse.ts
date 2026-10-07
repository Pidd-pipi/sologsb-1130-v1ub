/**
 * 排片清单文本解析。
 * 支持棚里另一套排片系统导出的 CSV / TSV（复制粘贴或文件文本均可），
 * 表头识别「镜号 / 日期 / 张数」三列，容错常见中文列名与英文别名。
 */
import type { PlanRowInput } from '../types/plan';
import { normalizeShotCode } from '../types/plan';

export interface ParseResult {
  rows: PlanRowInput[];
  /** 无法解析的原始行（1-based 行号，含表头偏移） */
  invalid: { lineNo: number; raw: string; reason: string }[];
}

type Column = 'code' | 'date' | 'frames' | 'note' | null;

const CODE_HEADERS = ['镜号', '镜头号', '镜头', 'shot', 'shotcode', 'code', '镜头编号'];
const DATE_HEADERS = ['日期', '拍摄日期', '计划日期', 'date', 'day', 'shootdate'];
const FRAMES_HEADERS = ['张数', '计划张数', '计划帧数', '帧数', 'frames', 'count', 'plannedframes', 'planned'];
const NOTE_HEADERS = ['备注', '场景', '说明', 'note', 'scene', 'remark'];

function classifyHeader(text: string): Column {
  const t = text.trim().toLowerCase().replace(/[\s_\-]/g, '');
  if (CODE_HEADERS.some((h) => t === h || t.includes(h))) return 'code';
  if (DATE_HEADERS.some((h) => t === h || t.includes(h.replace(/\s/g, '')))) return 'date';
  if (FRAMES_HEADERS.some((h) => t === h || t.includes(h))) return 'frames';
  if (NOTE_HEADERS.some((h) => t === h || t.includes(h))) return 'note';
  return null;
}

/** 拆一行：制表符优先，其次逗号；支持简单双引号包裹 */
function splitLine(line: string): string[] {
  const sep = line.includes('\t') ? '\t' : ',';
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      if (quoted && line[i + 1] === '"') {
        cur += '"';
        i += 1;
      } else {
        quoted = !quoted;
      }
    } else if (ch === sep && !quoted) {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

/** 日期归一：2026/1/5、2026.1.5、20260105、2026-1-05 → 2026-01-05 */
export function normalizeDate(raw: string): string | null {
  const s = raw.trim();
  let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(s);
  if (m) {
    return toIso(m[1], m[2], m[3]);
  }
  m = /^(\d{4})(\d{2})(\d{2})$/.exec(s);
  if (m) {
    return toIso(m[1], m[2], m[3]);
  }
  return null;
}

function toIso(y: string, mo: string, d: string): string | null {
  const year = Number(y);
  const month = Number(mo);
  const day = Number(d);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * 解析清单文本。
 * @param hasHeader 首行是否为表头；自动识别不出表头时按 镜号/日期/张数 固定三列处理
 */
export function parsePlanText(text: string, hasHeader = true): ParseResult {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  const result: ParseResult = { rows: [], invalid: [] };
  if (!lines.length) return result;

  let map: Column[];
  let bodyStart: number;
  const firstCells = splitLine(lines[0]);
  const detected = firstCells.map(classifyHeader);
  if (hasHeader && detected.includes('code') && detected.includes('date') && detected.includes('frames')) {
    map = detected;
    bodyStart = 1;
  } else {
    map = ['code', 'date', 'frames'];
    bodyStart = 0;
  }

  for (let i = bodyStart; i < lines.length; i += 1) {
    const cells = splitLine(lines[i]);
    let code = '';
    let date = '';
    let framesRaw = '';
    let note = '';
    for (let c = 0; c < cells.length; c += 1) {
      const kind = map[c] ?? null;
      if (kind === 'code') code = cells[c];
      else if (kind === 'date') date = cells[c];
      else if (kind === 'frames') framesRaw = cells[c];
      else if (kind === 'note') note = cells[c];
    }
    const normCode = normalizeShotCode(code);
    const normDate = normalizeDate(date);
    const frames = Number.parseInt(framesRaw, 10);
    if (!normCode || !normDate || !Number.isFinite(frames) || frames < 0) {
      result.invalid.push({
        lineNo: i + 1,
        raw: lines[i],
        reason: !normCode ? '镜号无法识别' : !normDate ? '日期无法识别' : '张数无法识别',
      });
      continue;
    }
    result.rows.push({ shotCode: normCode, date: normDate, plannedFrames: frames, note: note || undefined });
  }
  return result;
}

/**
 * 由清单内容派生稳定批次号（FNV-1a 32 位）。
 * 同一份清单无论由谁、在哪个标签页、提交几次，指纹一致 → 走幂等只入账一次。
 */
export function contentBatchId(rows: PlanRowInput[]): string {
  const canonical = rows
    .slice()
    .sort((a, b) => a.shotCode.localeCompare(b.shotCode) || a.date.localeCompare(b.date))
    .map((r) => `${r.shotCode}|${r.date}|${r.plannedFrames}`)
    .join('\n');
  let hash = 0x811c9dc5;
  for (let i = 0; i < canonical.length; i += 1) {
    hash ^= canonical.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `batch-${(hash >>> 0).toString(16).padStart(8, '0')}`;
}
