/**
 * 外部排片系统导出的清单条目（每天各镜头的计划拍摄张数）。
 * 以「镜号 + 拍摄日期」为业务键与本机实拍记录对账。
 */

/** 单条清单条目在对账中的处理状态 */
export type PlanReconStatus =
  | '未对账' // 刚导入，尚未跑对账或对账后无结论
  | '已对上' // 镜号、日期、张数与本机实拍一致
  | '张数不符' // 镜号与日期能对上，但张数不同
  | '日期不符' // 同镜号有实拍，但日期对不上
  | '清单独有' // 清单里有这个镜号（+日期），本机完全没有实拍
  | '已忽略'; // 人工判定无需处理（如撤拍/改期）

export const PLAN_RECON_STATUS_LABEL: Record<PlanReconStatus, string> = {
  未对账: '未对账',
  已对上: '已对上',
  张数不符: '张数不符',
  日期不符: '日期不符',
  清单独有: '清单独有',
  已忽略: '已忽略',
};

/** 排片清单单条目 */
export interface PlanEntry {
  id?: number;
  /** 镜号（外部系统原文，保留首尾空格以外的原样，匹配时再规范化） */
  shotCode: string;
  /** 计划拍摄日期 YYYY-MM-DD */
  date: string;
  /** 计划张数 */
  plannedFrames: number;
  /** 来源批次号（一次导入一份清单 = 一个批次），用于并发/重复提交幂等 */
  batchId: string;
  /** 批次内幂等键：batchId + '|' + 规范镜号 + '|' + date，建唯一索引防同批重复入账 */
  dedupKey: string;
  /** 对账状态 */
  reconStatus: PlanReconStatus;
  /** 对账时关联到的本机实拍记录 id（人工确认或自动对上后回写） */
  matchedTakeId?: number;
  /** 备注（外部清单可携带场景名等，仅备查） */
  note: string;
  createdAt: number;
  updatedAt: number;
}

/** 导入解析后的一行原始数据（尚未落库） */
export interface PlanRowInput {
  shotCode: string;
  date: string;
  plannedFrames: number;
  note?: string;
}

/** 一次导入的结果摘要 */
export interface PlanImportResult {
  batchId: string;
  /** 实际新写入的条目数 */
  inserted: number;
  /** 因同批次幂等键命中而跳过的条目数（同一份清单重复/并发提交不计两遍） */
  duplicated: number;
  /** 解析失败被丢弃的行数 */
  invalid: number;
}

/** 规范化镜号：去空白、统一大写，避免 “ s01 ” 与 “S01” 对不上 */
export function normalizeShotCode(code: string): string {
  return (code ?? '').toString().trim().replace(/\s+/g, '').toUpperCase();
}

/** 幂等键 */
export function planDedupKey(batchId: string, shotCode: string, date: string): string {
  return `${batchId}|${normalizeShotCode(shotCode)}|${date}`;
}
