/**
 * 棚里另一套排片系统导出的拍摄清单（收工后由场记收到）。
 * 一份清单（批次）含若干逐镜条目；导入后先按未对账归入待复核，
 * 与本机实拍记录逐镜对账，确认后才影响完成度。
 */

/** 对账结果（以本机实拍记录为准，清单张数永远不充作实拍） */
export type ReconcileStatus =
  | 'unreconciled' // 待复核：尚未确认
  | 'matched' // 已对上：镜号、日期、张数均一致
  | 'countMismatch' // 张数对不上
  | 'dateMismatch' // 日期对不上
  | 'shotMissing' // 清单镜号在本机不存在
  | 'reviewed'; // 差异已知悉（人工确认保留差异，不计入实拍）

export const RECONCILE_STATUS_LABEL: Record<ReconcileStatus, string> = {
  unreconciled: '待复核',
  matched: '已对上',
  countMismatch: '张数不符',
  dateMismatch: '日期不符',
  shotMissing: '本机无此镜号',
  reviewed: '已知悉差异',
};

/** 导入批次（一次提交的一整份清单） */
export interface ManifestBatch {
  id?: number;
  /** 批次名（通常为清单文件日期或文件名） */
  name: string;
  /**
   * 幂等键：清单条目归一化（镜号/日期/张数）后内容的哈希。
   * 唯一索引：两边几乎同时提交同一份清单时，第二批直接去重，不会算两遍。
   */
  batchKey: string;
  /** 清单标注的拍摄日期（可空，条目自带日期时以条目为准） */
  batchDate: string;
  /** 来源文件名 */
  sourceName: string;
  /** 导入条目数 */
  itemCount: number;
  createdAt: number;
}

/** 清单逐镜条目：该镜号当日计划/排出的张数 */
export interface PlanItem {
  id?: number;
  /** 所属批次 id */
  batchId: number;
  /** 清单镜号原文 */
  shotCode: string;
  /** 归一化镜号（去空白、全角转半角、大写），用于匹配 */
  shotCodeKey: string;
  /** 匹配到的本机镜头 id；未匹配为空 */
  shotId: number | null;
  /** 清单日期 YYYY-MM-DD */
  plannedDate: string;
  /** 清单计划张数 */
  plannedFrames: number;
  /** 对账结果 */
  status: ReconcileStatus;
  /** 最近对账时本机同日实拍张数（张数不符时展示） */
  actualFrames: number | null;
  /** 最近对账时本机命中的实拍日期（日期不符时展示） */
  actualDate: string | null;
  /** 是否已人工确认（差异已知悉 / 对上已确认） */
  reviewed: boolean;
  /** 备注（解析异常、重复行等） */
  note: string;
  createdAt: number;
  updatedAt: number;
}

/** 解析后的清单行（尚未入库） */
export interface ManifestRowInput {
  shotCode: string;
  plannedDate: string;
  plannedFrames: number;
}
