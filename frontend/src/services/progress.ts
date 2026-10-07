/**
 * 镜头完成度重算服务。
 * 数据源为「已核实实拍张数」：只有 已对上 / 张数不符（按实际）/ 本机独有 /
 * 已确认 / 本机直接登记未对账 的记录才计入；待复核（旧数据升级）与日期不符
 * 在人工处理前一律不并入，绝不默认算成拍完。
 */
import * as api from '../db/api';
import { durationToFrames } from '../utils/frameMath';
import { takeCountsTowardProgress } from '../types/take';
import type { Shot } from '../types/shot';
import type { TakeLog } from '../types/take';

export interface ShotRecalc {
  shotId: number;
  planned: number;
  taken: number;
  wasted: number;
  remaining: number;
  percent: number;
}

/** 纯计算：按已核实张数汇总一个镜头 */
export function summarizeShot(shot: Shot, takes: TakeLog[]): ShotRecalc {
  const planned = durationToFrames(shot.durationSec, shot.fps);
  const rows = takes.filter((t) => t.shotId === shot.id && takeCountsTowardProgress(t.reconStatus));
  const taken = rows.reduce((sum, t) => sum + (t.takenFrames || 0), 0);
  const wasted = rows.reduce((sum, t) => sum + (t.wastedFrames || 0), 0);
  const remaining = Math.max(0, planned - taken);
  const percent = Math.min(100, Math.round((taken / planned) * 100));
  return { shotId: shot.id ?? 0, planned, taken, wasted, remaining, percent };
}

/**
 * 重算指定镜头的完成度与剩余张数：
 * 回写 Shot.progressPercent 快照，并把该镜头各条实拍记录的快照字段同步为最新值。
 * 返回最新汇总。
 */
export async function recomputeShotProgress(shotId: number): Promise<ShotRecalc | undefined> {
  const shot = await api.getShot(shotId);
  if (!shot) return undefined;
  const rows = await api.listTakesByShot(shotId);
  const recalc = summarizeShot(shot, rows);
  await api.syncShotProgress(shotId, recalc.percent);
  await Promise.all(
    rows.map((row) => {
      if (typeof row.id !== 'number') return Promise.resolve();
      if (row.remainingFrames === recalc.remaining && row.percent === recalc.percent) return Promise.resolve();
      return api.updateTake(row.id, { remainingFrames: recalc.remaining, percent: recalc.percent });
    }),
  );
  return recalc;
}

/** 重算全部镜头（对账状态批量变化后使用），返回 id → 汇总 */
export async function recomputeAllProgress(): Promise<Map<number, ShotRecalc>> {
  const [shots, takes] = await Promise.all([api.listShots(), api.listTakes()]);
  const map = new Map<number, ShotRecalc>();
  for (const shot of shots) {
    if (typeof shot.id !== 'number') continue;
    const recalc = summarizeShot(shot, takes);
    map.set(shot.id, recalc);
  }
  await Promise.all(
    shots.map(async (shot) => {
      if (typeof shot.id !== 'number') return;
      const recalc = map.get(shot.id);
      if (!recalc) return;
      if (shot.progressPercent !== recalc.percent) await api.syncShotProgress(shot.id, recalc.percent);
      const rows = takes.filter((t) => t.shotId === shot.id);
      for (const row of rows) {
        if (typeof row.id !== 'number') continue;
        if (row.remainingFrames !== recalc.remaining || row.percent !== recalc.percent) {
          await api.updateTake(row.id, { remainingFrames: recalc.remaining, percent: recalc.percent });
        }
      }
    }),
  );
  return map;
}
