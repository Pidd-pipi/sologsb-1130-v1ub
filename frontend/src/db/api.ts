/** 数据访问层：所有读写都在这里收口，写入前统一脱代理 */
import { db, toPlain } from './index';
import type { Shot } from '../types/shot';
import type { FrameEntry } from '../types/frame';
import type { PropState } from '../types/prop';
import type { TakeLog, TakeReconStatus } from '../types/take';
import type { PlanEntry, PlanImportResult, PlanRowInput, PlanReconStatus } from '../types/plan';

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
  await db.transaction('rw', db.shots, db.frames, db.props, db.takes, async () => {
    await db.frames.where('shotId').equals(id).delete();
    await db.props.where('shotId').equals(id).delete();
    await db.takes.where('shotId').equals(id).delete();
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
  return db.takes.add(toPlain(take));
}

export async function updateTake(id: number, patch: Partial<TakeLog>): Promise<void> {
  await db.takes.update(id, toPlain({ ...patch, updatedAt: Date.now() }));
}

export async function deleteTake(id: number): Promise<void> {
  await db.takes.delete(id);
}

/** 按实拍张数回写镜头进度（Shot 表保存完成百分比快照，便于总览页快速读取） */
export async function syncShotProgress(shotId: number, percent: number): Promise<void> {
  await db.shots.update(shotId, toPlain({ progressPercent: percent, updatedAt: Date.now() }));
}

/** 批量改实拍记录对账状态（事务，保证状态与关联字段一起落库） */
export async function updateTakeRecon(
  ids: number[],
  patch: { reconStatus: TakeReconStatus; matchedPlanId?: number },
): Promise<void> {
  if (!ids.length) return;
  await db.transaction('rw', db.takes, async () => {
    for (const id of ids) {
      await db.takes.update(id, toPlain({ ...patch, updatedAt: Date.now() }));
    }
  });
}

/* ---------------- planEntries（外部排片清单） ---------------- */

export async function listPlanEntries(): Promise<PlanEntry[]> {
  const rows = await db.planEntries.toArray();
  return rows.sort((a, b) =>
    a.date < b.date ? 1 : a.date > b.date ? -1 : a.shotCode.localeCompare(b.shotCode, 'zh-Hans-CN'),
  );
}

/** 判断一个幂等键是否已存在（用于应用层先查后写）；串行读取避免事务内请求竞争 */
async function existingDedupKeys(table: typeof db.planEntries, keys: string[]): Promise<Set<string>> {
  const found = new Set<string>();
  for (const key of keys) {
    const hit = await table.where('dedupKey').equals(key).first();
    if (hit) found.add(key);
  }
  return found;
}

/**
 * 幂等批量导入一份清单。
 * - batchId 由导入内容派生：同一份清单重复/几乎同时提交，批次号相同；
 * - &dedupKey 唯一索引在数据库层兜底，事务冲突时整体重试，
 *   保证同一批（镜号+日期）的张数永远只入账一次，不会算两遍；
 * - 同一镜号+日期若在其他批次存在有效条目（撤换单），旧条目置为「已忽略」。
 */
export async function importPlanRows(rows: PlanRowInput[], batchId: string): Promise<PlanImportResult> {
  const result: PlanImportResult = { batchId, inserted: 0, duplicated: 0, invalid: 0 };
  const now = Date.now();

  // 同批次内先按 镜号+日期 去重（外部清单本身可能有重复行）
  const byKey = new Map<string, PlanRowInput>();
  for (const row of rows) {
    const code = row.shotCode.trim().replace(/\s+/g, '').toUpperCase();
    if (!code || !/^\d{4}-\d{2}-\d{2}$/.test(row.date) || !Number.isFinite(row.plannedFrames) || row.plannedFrames < 0) {
      result.invalid += 1;
      continue;
    }
    byKey.set(`${code}|${row.date}`, { ...row, shotCode: code });
  }

  const prepared: PlanEntry[] = Array.from(byKey.entries()).map(([key, row]) => ({
    shotCode: row.shotCode,
    date: row.date,
    plannedFrames: Math.floor(row.plannedFrames),
    batchId,
    dedupKey: `${batchId}|${key}`,
    reconStatus: '未对账',
    note: row.note ?? '',
    createdAt: now,
    updatedAt: now,
  }));

  if (!prepared.length) return result;

  const run = async () => {
    let inserted = 0;
    let duplicated = 0;
    await db.transaction('rw', db.planEntries, async () => {
      const table = db.planEntries;
      const have = await existingDedupKeys(table, prepared.map((p) => p.dedupKey));
      for (const entry of prepared) {
        if (have.has(entry.dedupKey)) {
          duplicated += 1;
          continue;
        }
        // 同镜号+日期的其他批次旧条目让位（以最新一份清单为准）
        const stale = await table
          .where('[shotCode+date]')
          .equals([entry.shotCode, entry.date])
          .filter((p) => p.dedupKey !== entry.dedupKey && p.reconStatus !== '已忽略')
          .toArray();
        for (const old of stale) {
          await table.update(old.id as number, { reconStatus: '已忽略', updatedAt: now });
        }
        await table.add(toPlain(entry));
        have.add(entry.dedupKey);
        inserted += 1;
      }
    });
    return { inserted, duplicated };
  };

  // 并发提交时唯一索引可能让先到者成功、后到者事务中止，整体重试后由幂等检查吃掉
  for (let attempt = 0; ; attempt += 1) {
    try {
      const { inserted, duplicated } = await run();
      result.inserted += inserted;
      result.duplicated += duplicated;
      return result;
    } catch (err) {
      if (attempt >= 2) throw err;
    }
  }
}

/** 批量回写清单条目的对账状态 */
export async function updatePlanRecon(
  ids: number[],
  patch: { reconStatus: PlanReconStatus; matchedTakeId?: number },
): Promise<void> {
  if (!ids.length) return;
  await db.transaction('rw', db.planEntries, async () => {
    for (const id of ids) {
      await db.planEntries.update(id, toPlain({ ...patch, updatedAt: Date.now() }));
    }
  });
}

/** 忽略单条清单条目（清单独有/日期不符经人工判定撤拍改期时用） */
export async function ignorePlanEntry(id: number): Promise<void> {
  await db.planEntries.update(id, toPlain({ reconStatus: '已忽略', updatedAt: Date.now() }));
}

export async function deletePlanEntry(id: number): Promise<void> {
  await db.planEntries.delete(id);
}

/** 清空某批次（重新导入前撤销用） */
export async function deletePlanBatch(batchId: string): Promise<void> {
  await db.planEntries.where('batchId').equals(batchId).delete();
}
