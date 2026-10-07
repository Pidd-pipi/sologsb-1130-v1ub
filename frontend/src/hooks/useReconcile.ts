/**
 * 排片清单对账：导入外部系统清单、按镜号/日期/张数分类、
 * 人工复核确认（对上的才并入完成度）、缺镜补建。
 */
import { computed, ref } from 'vue';
import * as api from '../db/api';
import { useShotStore } from '../stores/shotStore';
import { parseManifestText, type ParseResult } from '../utils/manifest';
import type { ManifestBatch, ManifestRowInput, PlanItem, ReconcileStatus } from '../types/manifest';

export interface GroupedItems {
  matched: PlanItem[];
  countMismatch: PlanItem[];
  dateMismatch: PlanItem[];
  shotMissing: PlanItem[];
  reviewed: PlanItem[];
  unreconciled: PlanItem[];
}

const GROUP_ORDER: ReconcileStatus[] = ['matched', 'countMismatch', 'dateMismatch', 'shotMissing', 'reviewed', 'unreconciled'];

export function groupItems(items: PlanItem[]): GroupedItems {
  const g: GroupedItems = { matched: [], countMismatch: [], dateMismatch: [], shotMissing: [], reviewed: [], unreconciled: [] };
  for (const item of items) {
    if (item.reviewed && item.status === 'matched') g.matched.push(item);
    else if (item.reviewed && item.status === 'reviewed') g.reviewed.push(item);
    else g[item.status]?.push(item);
  }
  for (const key of Object.keys(g) as (keyof GroupedItems)[]) {
    g[key].sort((a, b) => a.plannedDate.localeCompare(b.plannedDate) || a.shotCodeKey.localeCompare(b.shotCodeKey));
  }
  return g;
}

export function useReconcile() {
  const shotStore = useShotStore();
  const batches = ref<ManifestBatch[]>([]);
  const items = ref<PlanItem[]>([]);
  const selectedBatchId = ref<number | 'all'>('all');
  const loading = ref(false);
  const feedback = ref<{ type: 'ok' | 'err'; text: string } | null>(null);

  const visibleItems = computed(() =>
    selectedBatchId.value === 'all' ? items.value : items.value.filter((i) => i.batchId === selectedBatchId.value),
  );
  const groups = computed<GroupedItems>(() => groupItems(visibleItems.value));

  const pendingTakeIds = ref<number[]>([]);
  const pendingTakesLoaded = ref(false);

  const counts = computed(() => {
    const c: Record<ReconcileStatus, number> = {
      unreconciled: visibleItems.value.filter((i) => !i.reviewed && i.status === 'unreconciled').length,
      matched: visibleItems.value.filter((i) => !i.reviewed && i.status === 'matched').length,
      countMismatch: visibleItems.value.filter((i) => !i.reviewed && i.status === 'countMismatch').length,
      dateMismatch: visibleItems.value.filter((i) => !i.reviewed && i.status === 'dateMismatch').length,
      shotMissing: visibleItems.value.filter((i) => !i.reviewed && i.status === 'shotMissing').length,
      reviewed: visibleItems.value.filter((i) => i.reviewed).length,
    };
    return c;
  });

  /** 解析文件内容（不落库），把行和报错交回页面预览 */
  function previewFile(name: string, text: string, fallbackDate: string): ParseResult & { batchName: string } {
    const parsed = parseManifestText(text, fallbackDate);
    const batchName = name.replace(/\.(csv|json)$/i, '') || `清单 ${fallbackDate}`;
    return { ...parsed, batchName };
  }

  async function load() {
    loading.value = true;
    try {
      if (!shotStore.ready) await shotStore.load();
      batches.value = await api.listBatches();
      items.value = await api.listPlanItems();
      const takes = await api.listTakes();
      pendingTakeIds.value = takes.filter((t) => t.reviewStatus === 'pending').map((t) => t.id ?? 0).filter(Boolean);
      pendingTakesLoaded.value = true;
    } finally {
      loading.value = false;
    }
  }

  function flash(type: 'ok' | 'err', text: string) {
    feedback.value = { type, text };
    window.setTimeout(() => {
      if (feedback.value?.text === text) feedback.value = null;
    }, 4000);
  }

  /** 导入一批；同一份清单几乎同时提交时第二批被唯一键拦掉，不会算两遍 */
  async function importBatch(batchName: string, sourceName: string, rows: ManifestRowInput[]) {
    try {
      const result = await api.importManifest(batchName, sourceName, rows);
      await load();
      selectedBatchId.value = result.batchId;
      const c = result.counts;
      flash(
        'ok',
        `已导入 ${result.itemCount} 条：对上 ${c.matched} · 张数不符 ${c.countMismatch} · 日期不符 ${c.dateMismatch} · 本机无镜号 ${c.shotMissing}；全部先归入待复核`,
      );
      return true;
    } catch (e) {
      if (e instanceof api.DuplicateBatchError) {
        flash('err', '这份清单之前已经提交过，已自动去重，同一批张数没有算第二遍');
        selectedBatchId.value = e.existingBatchId;
        return false;
      }
      flash('err', `导入失败：${(e as Error).message}`);
      return false;
    }
  }

  async function confirmItem(item: PlanItem) {
    if (typeof item.id !== 'number') return;
    await api.confirmPlanItem(item.id);
    await load();
    await shotStore.load();
    flash('ok', item.status === 'matched' ? '已确认对上，实拍张数已并入该镜完成度' : '差异已知悉并标记（未计入实拍）');
  }

  /** 批量确认某一组：对上的并入完成度，差异组仅标记已知悉 */
  async function confirmGroup(status: 'matched' | 'countMismatch' | 'dateMismatch' | 'shotMissing' | 'unreconciled') {
    const targets = groups.value[status].filter((i) => !i.reviewed);
    if (!targets.length) return;
    await api.confirmPlanItems(targets.map((i) => i.id!));
    await load();
    await shotStore.load();
    flash('ok', `已处理本组 ${targets.length} 条`);
  }

  async function resetItem(item: PlanItem) {
    if (typeof item.id !== 'number') return;
    await api.resetPlanItem(item.id);
    await load();
    await shotStore.load();
    flash('ok', '已撤回确认，条目回到待复核');
  }

  /** 缺镜条目补建本机镜头：按清单张数排 24fps 时长 */
  async function createShotForItem(item: PlanItem) {
    if (typeof item.id !== 'number') return;
    await api.createShotForPlanItem(item.id, async (frames, code) => {
      const fps = 24;
      // 取不小于清单张数的最短时长，避免 24/24=1、25/24 这类浮点误差压短区间
      const durationSec = frames / fps;
      const saved = await shotStore.create({
        code,
        sceneName: '由排片清单补建',
        fps,
        durationSec,
        owner: '',
      });
      return saved.id!;
    });
    await load();
    flash('ok', `已按清单补建镜头 ${item.shotCode}（计划 ${item.plannedFrames} 张），请登记实拍后再对账`);
  }

  async function removeBatch(batch: ManifestBatch) {
    if (typeof batch.id !== 'number') return;
    await api.deleteBatch(batch.id);
    if (selectedBatchId.value === batch.id) selectedBatchId.value = 'all';
    await load();
    flash('ok', '已删除该批次清单（本机实拍记录不受影响）');
  }

  async function reevaluate() {
    await api.reevaluatePlanItems(selectedBatchId.value === 'all' ? undefined : selectedBatchId.value);
    await load();
    flash('ok', '已按当前实拍记录重新对账');
  }

  async function confirmPendingTakes() {
    await api.setTakeReviewStatus(pendingTakeIds.value, 'confirmed');
    pendingTakeIds.value = [];
    await shotStore.load();
    await load();
    flash('ok', '旧实拍记录已确认并按实际重算完成度');
  }

  return {
    batches,
    items,
    visibleItems,
    groups,
    counts,
    selectedBatchId,
    loading,
    feedback,
    pendingTakeIds,
    pendingTakesLoaded,
    groupOrder: GROUP_ORDER,
    previewFile,
    load,
    flash,
    importBatch,
    confirmItem,
    confirmGroup,
    resetItem,
    createShotForItem,
    removeBatch,
    reevaluate,
    confirmPendingTakes,
  };
}
