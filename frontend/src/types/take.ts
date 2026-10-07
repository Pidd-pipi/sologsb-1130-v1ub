/** 复核状态：旧数据升级与待对账记录先归入 pending，确认后才并入完成度 */
export type ReviewStatus = 'pending' | 'confirmed';

/** 一条实拍登记记录（按镜头 + 日期汇总当日张数） */
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
  /** 复核状态：pending 待复核（不计入完成度），confirmed 已确认（计入） */
  reviewStatus: ReviewStatus;
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
  reviewStatus: 'confirmed',
  updatedAt: Date.now(),
});

/** 废帧分布的一个分组 */
export interface WasteBucket {
  label: string;
  count: number;
}
