/** 数据访问层：所有读写都在这里收口，写入前统一脱代理 */
import { db, toPlain } from './index';
import type { Shot } from '../types/shot';
import type { FrameEntry } from '../types/frame';
import type { PropState } from '../types/prop';
import type { TakeLog, ReviewStatus } from '../types/take';
import type { ManifestBatch, ManifestRowInput, PlanItem, ReconcileStatus } from '../types/manifest';
import { durationToFrames } from '../utils/frameMath';
import { hashBatchKey, normalizeShotCode, reconcileRow } from '../utils/manifest';

export async function initDb(): Promise<void> {
  if (!db.isOpen()) await db.open();
}

/* ---------------- shots ---------------- */

export async function listShots(): Promise<Shot[]> {
  const rows = await db.shots.toArray();
  return rows.sort((a, b) => a.code.localeCompare(b.code, 'zh-Hans-CN'));
}

export async function getShot(id: number): Promise<Shot | undefined> {
  return db.shots.get(id);
}

export async function addShot(shot: Shot): Promise<number> {
  return db.shots.add(toPlain(shot));
}

export async function updateShot(id: number, patch: Partial<Shot>): Promise<void> {
  await db.shots.update(id, toPlain({ ...patch, updatedAt: Date.now() }));
}

export async function deleteShot(id: number): Promise<void> {
  await db.transaction('rw', db.shots, db.frames, db.props, db.takes, db.planItems, async () => {
    await db.frames.where('shotId').equals(id).delete();
    await db.props.where('shotId').equals(id).delete();
    await db.takes.where('shotId').equals(id).delete();
    // 清单条目解除与本机镜头的关联，回到「本机无此镜号」，而不是被一起物理删除
    await db.planItems.where('shotId').equals(id).modify({
      shotId: null,
      status: 'shotMissing',
      actualFrames: null,
      actualDate: null,
      reviewed: false,
      note: '本机镜头库中无此镜号',
    });
    await db.shots.delete(id);
  });
}

/* ---------------- frames ---------------- */

export async function listFrames(shotId: number): Promise<FrameEntry[]> {
  const rows = await db.frames.where('shotId').equals(shotId).toArray();
  return rows.sort((a, b) => a.frameNo - b.frameNo);
}

export async function listAllFrames(): Promise<FrameEntry[]> {
  return db.frames.toArray();
}

export async function addFrame(frame: FrameEntry): Promise<number> {
  return db.frames.add(toPlain(frame));
}

export async function addFrames(frames: FrameEntry[]): Promise<void> {
  if (!frames.length) return;
  await db.frames.bulkAdd(frames.map((f) => toPlain(f)));
}

export async function updateFrame(id: number, patch: Partial<FrameEntry>): Promise<void> {
  await db.frames.update(id, toPlain({ ...patch, updatedAt: Date.now() }));
}

export async function updateFrames(rows: FrameEntry[]): Promise<void> {
  await db.transaction('rw', db.frames, async () => {
    for (const row of rows) {
      if (typeof row.id !== 'number') continue;
      const { id, ...rest } = row;
      await db.frames.update(id, toPlain({ ...rest, updatedAt: Date.now() }));
    }
  });
}

export async function deleteFrame(id: number): Promise<void> {
  await db.frames.delete(id);
}

export async function replaceShotFrames(shotId: number, frames: FrameEntry[]): Promise<void> {
  const plain = frames.map((f) => toPlain(f));
  await db.transaction('rw', db.frames, async () => {
    await db.frames.where('shotId').equals(shotId).delete();
    if (plain.length) await db.frames.bulkAdd(plain);
  });
}

/* ---------------- props ---------------- */

export async function listProps(shotId: number): Promise<PropState[]> {
  const rows = await db.props.where('shotId').equals(shotId).toArray();
  return rows.sort((a, b) => a.fromFrame - b.fromFrame || a.name.localeCompare(b.name, 'zh-Hans-CN'));
}

export async function listAllProps(): Promise<PropState[]> {
  return db.props.toArray();
}

export async function addProp(prop: PropState): Promise<number> {
  return db.props.add(toPlain(prop));
}

export async function updateProp(id: number, patch: Partial<PropState>): Promise<void> {
  await db.props.update(id, toPlain({ ...patch, updatedAt: Date.now() }));
}

export async function deleteProp(id: number): Promise<void> {
  await db.props.delete(id);
}

/* ---------------- takes ---------------- */

export async function listTakes(): Promise<TakeLog[]> {
  const rows = await db.takes.toArray();
  return rows.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : (b.id ?? 0) - (a.id ?? 0)));
}

export async function listTakesByShot(shotId: number): Promise<TakeLog[]> {
  return db.takes.where('shotId').equals(shotId).toArray();
}

export async function addTake(take: TakeLog): Promise<number> {
  // 新登记实拍默认已确认（旧数据缺字段时在 v4 迁移中归入 pending）
  const row: TakeLog = toPlain({ ...take, reviewStatus: take.reviewStatus ?? 'confirmed' });
  const id = await db.takes.add(row);
  // 新登记的实拍张数是新的事实：按实际重算完成度与剩余，并重新评估该镜清单对账
  await recomputeShotProgress(row.shotId);
  await reevaluatePlanItemsForShot(row.shotId);
  return id;
}

export async function updateTake(id: number, patch: Partial<TakeLog>): Promise<void> {
  const updated = await db.takes.get(id);
  await db.takes.update(id, toPlain({ ...patch, updatedAt: Date.now() }));
  if (updated) {
    await recomputeShotProgress(updated.shotId);
    await reevaluatePlanItemsForShot(updated.shotId);
  }
}

export async function setTakeReviewStatus(ids: number[], status: ReviewStatus): Promise<void> {
  if (!ids.length) return;
  const affectedShots = new Set<number>();
  await db.transaction('rw', db.takes, db.shots, db.planItems, async () => {
    for (const id of ids) {
      const row = await db.takes.get(id);
      if (!row) continue;
      await db.takes.update(id, { reviewStatus: status, updatedAt: Date.now() });
      affectedShots.add(row.shotId);
    }
    for (const shotId of affectedShots) {
      // 确认后才并入完成度；取消确认则立即剔除
      await recomputeShotProgress(shotId);
      await reevaluatePlanItemsForShot(shotId);
    }
  });
}

export async function deleteTake(id: number): Promise<void> {
  const row = await db.takes.get(id);
  await db.takes.delete(id);
  if (row) {
    // 实拍张数一变就按实际重算，绝不靠增量累加
    await recomputeShotProgress(row.shotId);
    await reevaluatePlanItemsForShot(row.shotId);
  }
}

/** 待复核实拍条数（总览/实拍页提示旧数据还没确认） */
export async function countPendingTakes(): Promise<number> {
  return db.takes.where('reviewStatus').equals('pending').count();
}

/** 按实拍张数回写镜头进度（Shot 表保存完成百分比快照，便于总览页快速读取） */
export async function syncShotProgress(shotId: number, percent: number): Promise<void> {
  await db.shots.update(shotId, toPlain({ progressPercent: percent, updatedAt: Date.now() }));
}

/**
 * 完成度统一重算入口（幂等、非累加）：
 * 只统计 reviewStatus='confirmed' 的实拍记录；
 * 待复核旧数据确认前不会被默认算成拍完。
 * 同时刷新每条实拍记录上的剩余张数/完成度快照。
 */
export async function recomputeShotProgress(shotId: number): Promise<void> {
  await db.transaction('rw', db.takes, db.shots, async () => {
    const shot = await db.shots.get(shotId);
    if (!shot) return;
    const planned = durationToFrames(shot.durationSec, shot.fps);
    const rows = await db.takes.where('shotId').equals(shotId).toArray();
    const confirmed = rows.filter((r) => r.reviewStatus === 'confirmed');
    const taken = confirmed.reduce((sum, r) => sum + (r.takenFrames || 0), 0);
    const wasted = confirmed.reduce((sum, r) => sum + (r.wastedFrames || 0), 0);
    const remaining = Math.max(0, planned - taken);
    const percent = Math.min(100, Math.round((taken / planned) * 100));
    for (const r of rows) {
      await db.takes.update(r.id!, { remainingFrames: remaining, percent });
    }
    await db.shots.update(shotId, { progressPercent: percent, updatedAt: Date.now() });
  });
}

/* ---------------- 排片清单（外部系统导入对账） ---------------- */

export class DuplicateBatchError extends Error {
  existingBatchId: number;
  constructor(existingBatchId: number) {
    super('同一份清单已导入过，已自动去重，同一批张数不会算两遍');
    this.name = 'DuplicateBatchError';
    this.existingBatchId = existingBatchId;
  }
}

export interface ImportManifestResult {
  batchId: number;
  itemCount: number;
  counts: Record<ReconcileStatus, number>;
}

/**
 * 导入一份排片清单并完成初次对账：
 * - batchKey 唯一：两边几乎同时提交同一份清单时，第二批在事务内被拦，不会产生重复条目；
 * - 按镜号认本机镜头，按日期/张数分出 对上 / 张数不符 / 日期不符 / 本机无此镜号；
 * - 新导入一律先待复核，清单张数不会被加进实拍。
 */
export async function importManifest(
  name: string,
  sourceName: string,
  rows: ManifestRowInput[],
): Promise<ImportManifestResult> {
  if (!rows.length) throw new Error('清单没有可导入的条目');
  const batchKey = hashBatchKey(rows);
  const now = Date.now();

  return db.transaction('rw', db.manifestBatches, db.planItems, db.shots, db.takes, async () => {
    const existing = await db.manifestBatches.where('batchKey').equals(batchKey).first();
    if (existing && typeof existing.id === 'number') {
      throw new DuplicateBatchError(existing.id);
    }
    const shots = await db.shots.toArray();
    const codeIndex = new Map(shots.map((s) => [normalizeShotCode(s.code), s.id ?? 0]));
    const takes = await db.takes.toArray();
    const batchDate = rows[0]?.plannedDate ?? '';

    const batchId = await db.manifestBatches.add(
      toPlain<ManifestBatch>({ name, batchKey, batchDate, sourceName, itemCount: rows.length, createdAt: now }),
    );
    const id = batchId as number;

    const counts: Record<ReconcileStatus, number> = {
      unreconciled: 0,
      matched: 0,
      countMismatch: 0,
      dateMismatch: 0,
      shotMissing: 0,
      reviewed: 0,
    };
    const items: PlanItem[] = rows.map((r) => {
      const key = normalizeShotCode(r.shotCode);
      const shotId = codeIndex.has(key) ? codeIndex.get(key)! : null;
      const result = reconcileRow(
        { shotCode: r.shotCode, shotId, plannedDate: r.plannedDate, plannedFrames: r.plannedFrames },
        takes,
      );
      counts[result.status] += 1;
      return toPlain<PlanItem>({
        batchId: id,
        shotCode: r.shotCode.trim(),
        shotCodeKey: key,
        shotId,
        plannedDate: r.plannedDate,
        plannedFrames: r.plannedFrames,
        status: result.status,
        actualFrames: result.actualFrames,
        actualDate: result.actualDate,
        reviewed: false,
        note: result.note,
        createdAt: now,
        updatedAt: now,
      });
    });
    if (items.length) await db.planItems.bulkAdd(items);
    return { batchId: id, itemCount: items.length, counts };
  });
}

export async function listBatches(): Promise<ManifestBatch[]> {
  const rows = await db.manifestBatches.toArray();
  return rows.sort((a, b) => b.createdAt - a.createdAt);
}

export async function listPlanItems(batchId?: number): Promise<PlanItem[]> {
  const rows = typeof batchId === 'number' ? await db.planItems.where('batchId').equals(batchId).toArray() : await db.planItems.toArray();
  return rows.sort((a, b) => (a.plannedDate < b.plannedDate ? -1 : a.plannedDate > b.plannedDate ? 1 : a.shotCodeKey.localeCompare(b.shotCodeKey)));
}

/** 重新认镜号并重算全部条目（新建镜头/手动对账后使用），已人工确认的条目保持确认结论 */
export async function reevaluatePlanItems(batchId?: number): Promise<void> {
  await db.transaction('rw', db.planItems, db.shots, db.takes, async () => {
    const shots = await db.shots.toArray();
    const codeIndex = new Map(shots.map((s) => [normalizeShotCode(s.code), s.id ?? 0]));
    const takes = await db.takes.toArray();
    const items = typeof batchId === 'number'
      ? await db.planItems.where('batchId').equals(batchId).toArray()
      : await db.planItems.toArray();
    for (const item of items) {
      if (typeof item.id !== 'number') continue;
      const shotId = codeIndex.has(item.shotCodeKey) ? codeIndex.get(item.shotCodeKey)! : null;
      // 已对上的实拍张数一变就按实际重算：确认过的条目也要重新对账，不能沿用旧结论
      const result = reconcileRow(
        { shotCode: item.shotCode, shotId, plannedDate: item.plannedDate, plannedFrames: item.plannedFrames },
        takes,
      );
      // 已人工确认的条目保留结论：对上→matched；差异已知悉→reviewed；未确认→用最新对账结果
      const status: ReconcileStatus = item.reviewed
        ? result.status === 'matched'
          ? 'matched'
          : 'reviewed'
        : result.status;
      await db.planItems.update(item.id, {
        shotId,
        status,
        actualFrames: result.actualFrames,
        actualDate: result.actualDate,
        note: result.note,
        updatedAt: Date.now(),
      });
    }
  });
}

/** 实拍变动后重评该镜头关联的未决条目；已「已知悉差异」的人工结论保留 */
export async function reevaluatePlanItemsForShot(shotId: number): Promise<void> {
  await db.transaction('rw', db.planItems, db.takes, async () => {
    const takes = await db.takes.toArray();
    const items = await db.planItems.where('shotId').equals(shotId).toArray();
    for (const item of items) {
      if (typeof item.id !== 'number') continue;
      if (item.reviewed && item.status === 'reviewed') continue;
      const result = reconcileRow(
        { shotCode: item.shotCode, shotId, plannedDate: item.plannedDate, plannedFrames: item.plannedFrames },
        takes,
      );
      await db.planItems.update(item.id, {
        status: result.status,
        actualFrames: result.actualFrames,
        actualDate: result.actualDate,
        note: result.note,
        updatedAt: Date.now(),
      });
    }
  });
}

/**
 * 人工确认条目：
 * - 对上：把同日尚未确认的实拍记录一并确认，并入完成度，条目置 reviewed；
 * - 差异（张数/日期不符、缺镜）：标记「已知悉差异」，不改实拍、不充数。
 */
export async function confirmPlanItem(itemId: number): Promise<void> {
  await db.transaction('rw', db.planItems, db.takes, db.shots, async () => {
    const item = await db.planItems.get(itemId);
    if (!item || item.reviewed) return;
    const now = Date.now();
    if (item.status === 'matched' && typeof item.shotId === 'number') {
      const sameDay = await db.takes
        .where('shotId')
        .equals(item.shotId)
        .filter((t) => t.date === item!.plannedDate && t.reviewStatus !== 'confirmed')
        .toArray();
      for (const t of sameDay) {
        await db.takes.update(t.id!, { reviewStatus: 'confirmed', updatedAt: now });
      }
      await recomputeShotProgress(item.shotId);
      await db.planItems.update(itemId, { reviewed: true, status: 'matched', updatedAt: now });
    } else {
      await db.planItems.update(itemId, { reviewed: true, status: 'reviewed', updatedAt: now });
    }
  });
}

/** 批量确认条目（内部逐条走 confirmPlanItem 的同一套规则） */
export async function confirmPlanItems(itemIds: number[]): Promise<void> {
  for (const id of itemIds) {
    await confirmPlanItem(id);
  }
}

/** 撤回人工结论，条目回到当前对账结果的待复核状态 */
export async function resetPlanItem(itemId: number): Promise<void> {
  const item = await db.planItems.get(itemId);
  if (!item || typeof item.id !== 'number') return;
  await db.transaction('rw', db.planItems, db.shots, db.takes, async () => {
    const shotId = item.shotId;
    const takes = await db.takes.toArray();
    const result = reconcileRow(
      { shotCode: item.shotCode, shotId, plannedDate: item.plannedDate, plannedFrames: item.plannedFrames },
      takes,
    );
    await db.planItems.update(item.id!, {
      status: result.status,
      actualFrames: result.actualFrames,
      actualDate: result.actualDate,
      note: result.note,
      reviewed: false,
      updatedAt: Date.now(),
    });
    if (typeof shotId === 'number') await recomputeShotProgress(shotId);
  });
}

export async function deleteBatch(batchId: number): Promise<void> {
  await db.transaction('rw', db.manifestBatches, db.planItems, async () => {
    await db.planItems.where('batchId').equals(batchId).delete();
    await db.manifestBatches.delete(batchId);
  });
}

/**
 * 为「本机无此镜号」条目补建镜头（场记确认镜号确实存在）。
 * 新镜头按清单张数反推时长（按 24fps），随后整批复核状态重评。
 */
export async function createShotForPlanItem(itemId: number, createShot: (frames: number, code: string) => Promise<number>): Promise<void> {
  const item = await db.planItems.get(itemId);
  if (!item || item.shotId !== null) return;
  const shotId = await createShot(item.plannedFrames, item.shotCode);
  await db.planItems.update(itemId, { shotId, updatedAt: Date.now() });
  await reevaluatePlanItems(item.batchId);
}
