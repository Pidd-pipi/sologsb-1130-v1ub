/**
 * 拍摄进度：由实拍张数与废帧数计算镜头完成百分比与剩余张数。
 * 被 / 与 /progress 消费。
 * 只有通过对账或本机确认的实拍张数才计入（见 takeCountsTowardProgress）；
 * 待复核（旧数据升级）与日期不符的记录在人工处理前不并入完成度。
 */
import { computed, ref } from 'vue';
import * as api from '../db/api';
import { useShotStore } from '../stores/shotStore';
import { durationToFrames } from '../utils/frameMath';
import { takeCountsTowardProgress } from '../types/take';
import type { Shot } from '../types/shot';
import type { TakeLog, WasteBucket } from '../types/take';
import { createEmptyTake } from '../types/take';
import { recomputeShotProgress } from '../services/progress';

export interface ShotProgressSummary {
  shotId: number;
  code: string;
  planned: number;
  taken: number;
  wasted: number;
  remaining: number;
  percent: number;
}

/** 纯函数：按实拍张数/废帧数算进度 */
export function computeProgress(planned: number, taken: number, wasted: number) {
  const total = Math.max(1, Math.floor(planned));
  const done = Math.max(0, Math.floor(taken));
  const bad = Math.max(0, Math.floor(wasted));
  const remaining = Math.max(0, total - done);
  const percent = Math.min(100, Math.round((done / total) * 100));
  return { planned: total, taken: done, wasted: bad, remaining, percent };
}

export function useProgress() {
  const shotStore = useShotStore();
  const takes = ref<TakeLog[]>([]);
  const loading = ref(false);

  /** 已核实可计入完成度的实拍记录 */
  const verifiedTakes = computed(() => takes.value.filter((t) => takeCountsTowardProgress(t.reconStatus)));

  const summaries = computed<ShotProgressSummary[]>(() =>
    shotStore.shots.map((shot) => {
      const planned = durationToFrames(shot.durationSec, shot.fps);
      const rows = verifiedTakes.value.filter((t) => t.shotId === shot.id);
      const taken = rows.reduce((sum, r) => sum + (r.takenFrames || 0), 0);
      const wasted = rows.reduce((sum, r) => sum + (r.wastedFrames || 0), 0);
      const p = computeProgress(planned, taken, wasted);
      return { shotId: shot.id ?? 0, code: shot.code, ...p };
    }),
  );

  const overall = computed(() => {
    const planned = summaries.value.reduce((s, x) => s + x.planned, 0);
    const taken = summaries.value.reduce((s, x) => s + x.taken, 0);
    const wasted = summaries.value.reduce((s, x) => s + x.wasted, 0);
    const remaining = summaries.value.reduce((s, x) => s + x.remaining, 0);
    const percent = planned ? Math.min(100, Math.round((taken / planned) * 100)) : 0;
    return { planned, taken, wasted, remaining, percent };
  });

  /** 废帧分布：按张数区间分桶（仅已核实记录） */
  const wasteBuckets = computed<WasteBucket[]>(() => {
    const buckets: WasteBucket[] = [
      { label: '0 张', count: 0 },
      { label: '1-2 张', count: 0 },
      { label: '3-5 张', count: 0 },
      { label: '6 张以上', count: 0 },
    ];
    for (const row of verifiedTakes.value) {
      const n = row.wastedFrames || 0;
      if (n === 0) buckets[0].count += 1;
      else if (n <= 2) buckets[1].count += 1;
      else if (n <= 5) buckets[2].count += 1;
      else buckets[3].count += 1;
    }
    return buckets;
  });

  async function loadTakes() {
    loading.value = true;
    try {
      takes.value = await api.listTakes();
    } finally {
      loading.value = false;
    }
  }

  /** 登记后从库里回捞该镜头最新记录，同步本地列表与完成度快照 */
  async function refreshShotTakes(shotId: number) {
    const rows = await api.listTakesByShot(shotId);
    const others = takes.value.filter((t) => t.shotId !== shotId);
    takes.value = [...rows, ...others].sort((a, b) =>
      a.date < b.date ? 1 : a.date > b.date ? -1 : (b.id ?? 0) - (a.id ?? 0),
    );
  }

  function emptyTake(shot: Shot): TakeLog {
    const planned = durationToFrames(shot.durationSec, shot.fps);
    const rows = verifiedTakes.value.filter((t) => t.shotId === shot.id);
    const taken = rows.reduce((sum, r) => sum + (r.takenFrames || 0), 0);
    const wasted = rows.reduce((sum, r) => sum + (r.wastedFrames || 0), 0);
    const p = computeProgress(planned, taken, wasted);
    return { ...createEmptyTake(shot.id ?? 0, shot.code), remainingFrames: p.remaining, percent: p.percent };
  }

  /**
   * 登记一条本机实拍记录。
   * 新记录为「未对账」：实拍张数先按实际计入，等排片清单导入后再核对；
   * 登记完成后以该镜头全部已核实张数重算完成度与剩余。
   */
  async function registerTake(shot: Shot, date: string, takenFrames: number, wastedFrames: number) {
    const planned = durationToFrames(shot.durationSec, shot.fps);
    const prevRows = verifiedTakes.value.filter((t) => t.shotId === shot.id);
    const prevTaken = prevRows.reduce((sum, r) => sum + (r.takenFrames || 0), 0);
    const prevWasted = prevRows.reduce((sum, r) => sum + (r.wastedFrames || 0), 0);
    const p = computeProgress(planned, prevTaken + takenFrames, prevWasted + wastedFrames);
    const row: TakeLog = {
      date,
      shotCode: shot.code,
      shotId: shot.id ?? 0,
      takenFrames,
      wastedFrames,
      remainingFrames: p.remaining,
      percent: p.percent,
      reconStatus: '未对账',
      updatedAt: Date.now(),
    };
    const id = await api.addTake(row);
    if (typeof shot.id === 'number') {
      // 以数据库为准重算，保证同镜头各条记录的剩余/百分比快照一致
      const recalc = await recomputeShotProgress(shot.id);
      await refreshShotTakes(shot.id);
      if (recalc) await shotStore.syncProgress(shot.id, recalc.percent);
    }
    return { ...row, id };
  }

  async function removeTake(id: number) {
    const target = takes.value.find((t) => t.id === id);
    await api.deleteTake(id);
    takes.value = takes.value.filter((t) => t.id !== id);
    if (target && typeof target.shotId === 'number') {
      const recalc = await recomputeShotProgress(target.shotId);
      await refreshShotTakes(target.shotId);
      if (recalc) await shotStore.syncProgress(target.shotId, recalc.percent);
    }
  }

  return {
    takes,
    loading,
    summaries,
    overall,
    wasteBuckets,
    loadTakes,
    emptyTake,
    registerTake,
    removeTake,
    computeProgress,
  };
}
