/** 一条实拍登记记录（按镜头 + 日期汇总当日张数） */

/**
 * 对账状态：
 * - 未对账：v3 旧数据升级后的默认归属，或手工登记后尚未与排片清单核对
 * - 待复核：旧数据迁移时先归入此态，需人工确认后才并入完成度
 * - 已对上：与某条清单条目镜号/日期/张数全部一致
 * - 张数不符：镜号日期对上但张数不一致，以实际登记张数重算，标记差异
 * - 日期不符：镜号有清单但日期对不上
 * - 本机独有：本机登记了实拍，清单里没有该镜号（+日期）
 * - 已确认：人工复核通过（旧数据确认入口）
 */
export type TakeReconStatus =
  | '未对账'
  | '待复核'
  | '已对上'
  | '张数不符'
  | '日期不符'
  | '本机独有'
  | '已确认';

export const TAKE_RECON_STATUS_LABEL: Record<TakeReconStatus, string> = {
  未对账: '未对账',
  待复核: '待复核',
  已对上: '已对上',
  张数不符: '张数不符',
  日期不符: '日期不符',
  本机独有: '本机独有',
  已确认: '已确认',
};

/** 哪些对账状态下实拍张数可以计入完成度（待复核旧数据与日期不符须先处理，不默认算拍完） */
export function takeCountsTowardProgress(status: TakeReconStatus | undefined): boolean {
  return (
    status === '已对上' ||
    status === '张数不符' || // 张数以本机实际登记为准
    status === '本机独有' ||
    status === '未对账' || // 本机直接登记的实拍，先按实际计入，待清单来了再核对
    status === '已确认'
  );
}

export interface TakeLog {
  id?: number;
  /** 拍摄日期 YYYY-MM-DD */
  date: string;
  /** 镜号，便于按镜头阅读 */
  shotCode: string;
  /** 关联镜头 id */
  shotId: number;
  /** 实拍张数 */
  takenFrames: number;
  /** 废帧数 */
  wastedFrames: number;
  /** 剩余张数（登记时快照） */
  remainingFrames: number;
  /** 完成百分比 0-100 */
  percent: number;
  /** 对账状态；旧数据（v3 及以前）升级后为「待复核」 */
  reconStatus: TakeReconStatus;
  /** 幂等键：来源批次 + 镜号 + 日期，防止同一份清单并发/重复提交把张数算两遍 */
  dedupKey?: string;
  /** 对到的清单条目 id */
  matchedPlanId?: number;
  updatedAt: number;
}

export const createEmptyTake = (shotId: number, shotCode: string): TakeLog => ({
  date: new Date().toISOString().slice(0, 10),
  shotCode,
  shotId,
  takenFrames: 0,
  wastedFrames: 0,
  remainingFrames: 0,
  percent: 0,
  reconStatus: '未对账',
  updatedAt: Date.now(),
});

/** 废帧分布的一个分组 */
export interface WasteBucket {
  label: string;
  count: number;
}
