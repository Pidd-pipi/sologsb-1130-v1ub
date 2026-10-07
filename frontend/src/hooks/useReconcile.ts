/**
 * 排片清单对账工作流。
 * - 导入幂等：批次号由清单内容派生 + &dedupKey 唯一索引，同一批张数不重复入账；
 * - 对账：纯函数 reconcile 产出四类差异，applyReconcile 落库状态；
 * - 任何确认/忽略动作后，受影响镜头按实际已核实张数重算完成度与剩余。
 */
import { computed, ref } from 'vue';
import * as api from '../db/api';
import { useShotStore } from '../stores/shotStore';
import { reconcile, type ReconResult } from '../utils/reconcile';
import { recomputeAllProgress, recomputeShotProgress } from '../services/progress';
import { contentBatchId, parsePlanText, type ParseResult } from '../utils/planParse';
import type { PlanImportResult, PlanReconStatus, PlanRowInput } from '../types/plan';
import type { TakeLog } from '../types/take';

const EMPTY_RESULT: ReconResult = {
  matched: [],
  countMismatch: [],
  dateMismatch: [],
  planOnly: [],
  localOnly: [],
  pendingReview: [],
  pendingMatched: [],
};

export function useReconcile() {
  const shotStore = useShotStore();
  const takes = ref<TakeLog[]>([]);
  const loading = ref(false);
  const importing = ref(false);
  const lastImport = ref<PlanImportResult | null>(null);

  const result = ref<ReconResult>({ ...EMPTY_RESULT });

  const totalPlans = computed(
    () =>
      result.value.matched.length +
      result.value.countMismatch.length +
      result.value.dateMismatch.filter((d) => !!d.plan).length +
      result.value.planOnly.length,
  );
  const hasDiscrepancy = computed(
    () =>
      result.value.countMismatch.length > 0 ||
      result.value.dateMismatch.length > 0 ||
      result.value.planOnly.length > 0 ||
      result.value.localOnly.length > 0 ||
      result.value.pendingReview.length > 0,
  );

  async function loadAll() {
    loading.value = true;
    try {
      if (!shotStore.ready) await shotStore.load();
      const [takeRows, plans] = await Promise.all([api.listTakes(), api.listPlanEntries()]);
      takes.value = takeRows;
      result.value = reconcile(takeRows, plans);
    } finally {
      loading.value = false;
    }
  }

  /** 解析粘贴文本（不落库），供页面预览无效行与条数 */
  function preview(text: string, hasHeader: boolean): ParseResult {
    return parsePlanText(text, hasHeader);
  }

  /**
   * 导入一份清单。同内容清单（含两个标签页几乎同时提交）批次指纹相同，
   * 数据库唯一索引兜底，重复条目计入 duplicated，绝不把同一批张数算两遍。
   */
  async function importRows(rows: PlanRowInput[]): Promise<PlanImportResult> {
    importing.value = true;
    try {
      const batchId = contentBatchId(rows);
      const summary = await api.importPlanRows(rows, batchId);
      lastImport.value = summary;
      await loadAll();
      return summary;
    } finally {
      importing.value = false;
    }
  }

  async function importText(text: string, hasHeader: boolean): Promise<{ parse: ParseResult; import: PlanImportResult }> {
    const parse = parsePlanText(text, hasHeader);
    const summary = await importRows(parse.rows);
    return { parse, import: summary };
  }

  /** 重新跑对账并把状态写库；已确认的旧数据与已忽略清单保持人工结论不动 */
  async function applyReconcile() {
    const r = result.value;
    const takePatch = new Map<number, { reconStatus: TakeLog['reconStatus']; matchedPlanId?: number }>();
    const planPatch = new Map<number, { reconStatus: PlanReconStatus; matchedTakeId?: number }>();

    const collectTake = (
      rows: TakeLog[],
      status: TakeLog['reconStatus'],
      planId?: number,
    ) => {
      for (const t of rows) {
        if (typeof t.id !== 'number') continue;
        if (t.reconStatus === '已确认' || t.reconStatus === '待复核') continue; // 人工结论优先
        takePatch.set(t.id, { reconStatus: status, matchedPlanId: planId });
      }
    };
    const collectPlan = (planId: number | undefined, status: PlanReconStatus, takeId?: number) => {
      if (typeof planId !== 'number') return;
      planPatch.set(planId, { reconStatus: status, matchedTakeId: takeId });
    };

    for (const m of r.matched) {
      collectPlan(m.plan.id, '已对上', m.takes[0]?.id);
      collectTake(m.takes, '已对上', m.plan.id);
    }
    for (const m of r.countMismatch) {
      collectPlan(m.plan.id, '张数不符', m.takes[0]?.id);
      // 张数以本机实际为准：仍计入完成度，但状态保留差异提示
      collectTake(m.takes, '张数不符', m.plan.id);
    }
    for (const d of r.dateMismatch) {
      if (d.plan) collectPlan(d.plan.id, '日期不符', d.take?.id);
      if (d.take) collectTake([d.take], '日期不符', d.plan?.id); // 日期不符不并入完成度
    }
    for (const p of r.planOnly) {
      collectPlan(p.plan.id, '清单独有');
    }
    for (const l of r.localOnly) {
      collectTake([l.take], '本机独有'); // 本机实拍为实际进度，仍计入
    }

    await Promise.all([
      ...Array.from(takePatch.entries()).map(([id, patch]) =>
        api.updateTakeRecon([id], { reconStatus: patch.reconStatus, matchedPlanId: patch.matchedPlanId }),
      ),
      ...Array.from(planPatch.entries()).map(([id, patch]) =>
        api.updatePlanRecon([id], { reconStatus: patch.reconStatus, matchedTakeId: patch.matchedTakeId }),
      ),
    ]);
    await recomputeAllProgress();
    await shotStore.load();
    await loadAll();
  }

  /** 确认单条「已对上」：仅更新对应两侧状态并重算该镜头 */
  async function confirmMatched(planId: number, takeIds: number[]) {
    await Promise.all([
      api.updatePlanRecon([planId], { reconStatus: '已对上', matchedTakeId: takeIds[0] }),
      ...takeIds.map((id) => api.updateTakeRecon([id], { reconStatus: '已对上', matchedPlanId: planId })),
    ]);
    await afterTakeChange(takeIds);
  }

  /** 张数不符：以本机实际张数为准确认，重算完成度 */
  async function acceptActualCount(planId: number, takeIds: number[]) {
    await Promise.all([
      api.updatePlanRecon([planId], { reconStatus: '张数不符', matchedTakeId: takeIds[0] }),
      ...takeIds.map((id) => api.updateTakeRecon([id], { reconStatus: '张数不符', matchedPlanId: planId })),
    ]);
    await afterTakeChange(takeIds);
  }

  /**
   * 日期不符：确认按本机实拍日期为准（计划改期已落实），
   * 实拍记录并入完成度，清单条目标记已对上。
   */
  async function resolveDateByActual(planId: number, takeId: number) {
    await Promise.all([
      api.updatePlanRecon([planId], { reconStatus: '已对上', matchedTakeId: takeId }),
      api.updateTakeRecon([takeId], { reconStatus: '已对上', matchedPlanId: planId }),
    ]);
    await afterTakeChange([takeId]);
  }

  /** 日期不符：确认清单计划为准（本机登记有误），实拍暂不并入，等待更正实拍记录 */
  async function resolveDateByPlan(planId: number, takeId: number) {
    await Promise.all([
      api.updatePlanRecon([planId], { reconStatus: '日期不符', matchedTakeId: takeId }),
      api.updateTakeRecon([takeId], { reconStatus: '日期不符', matchedPlanId: planId }),
    ]);
    await afterTakeChange([takeId]);
  }

  /** 日期不符中只有实拍侧的行（该日期无计划条目）：人工确认实拍有效，并入完成度 */
  async function confirmDateTake(takeId: number) {
    await api.updateTakeRecon([takeId], { reconStatus: '已确认' });
    await afterTakeChange([takeId]);
  }

  /** 清单独有条目忽略（撤拍/改期） */
  async function ignorePlan(planId: number) {
    await api.ignorePlanEntry(planId);
    await loadAll();
  }

  /** 本机独有实拍：确认确有拍摄（维持计入完成度） */
  async function confirmLocalTake(takeId: number) {
    await api.updateTakeRecon([takeId], { reconStatus: '本机独有' });
    await afterTakeChange([takeId]);
  }

  /**
   * 旧数据复核：确认一条 v3 遗留实拍记录真实有效 → 已确认并并入完成度。
   * 未确认的待复核记录始终不进完成度。
   */
  async function confirmPendingReview(takeId: number) {
    await api.updateTakeRecon([takeId], { reconStatus: '已确认' });
    await afterTakeChange([takeId]);
  }

  /** 待复核记录与当日清单张数也一致：确认实拍并同时把清单标为已对上 */
  async function confirmPendingMatched(takeId: number, planId: number) {
    await Promise.all([
      api.updatePlanRecon([planId], { reconStatus: '已对上', matchedTakeId: takeId }),
      api.updateTakeRecon([takeId], { reconStatus: '已对上', matchedPlanId: planId }),
    ]);
    await afterTakeChange([takeId]);
  }

  /** 待复核记录核实为误登：直接删除，不并入任何进度 */
  async function discardPendingReview(takeId: number) {
    const target = takes.value.find((t) => t.id === takeId);
    await api.deleteTake(takeId);
    if (target) await recomputeShotProgress(target.shotId);
    await shotStore.load();
    await loadAll();
  }

  async function afterTakeChange(takeIds: number[]) {
    const shotIds = new Set(
      takeIds
        .map((id) => takes.value.find((t) => t.id === id)?.shotId)
        .filter((x): x is number => typeof x === 'number'),
    );
    for (const shotId of shotIds) await recomputeShotProgress(shotId);
    await shotStore.load();
    await loadAll();
  }

  return {
    takes,
    result,
    loading,
    importing,
    lastImport,
    totalPlans,
    hasDiscrepancy,
    loadAll,
    preview,
    importRows,
    importText,
    applyReconcile,
    confirmMatched,
    acceptActualCount,
    resolveDateByActual,
    resolveDateByPlan,
    confirmDateTake,
    ignorePlan,
    confirmLocalTake,
    confirmPendingReview,
    confirmPendingMatched,
    discardPendingReview,
  };
}
