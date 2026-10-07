/**
 * 对账核心（纯函数，无 IndexedDB 依赖，便于单测与复用）。
 *
 * 外部排片清单（PlanEntry）按「镜号 + 日期」与本机实拍记录（TakeLog）核对：
 *  - 镜号 + 日期一致且张数一致 → 已对上
 *  - 镜号 + 日期一致但张数不同 → 张数不符（完成度仍按实际实拍张数重算）
 *  - 镜号认得到、日期在两边对不上 → 日期不符（不默认算拍完）
 *  - 清单里有、本机没有该镜号实拍 → 清单独有
 *  - 本机有、清单里没有 → 本机独有
 * 待复核（旧数据升级）的实拍记录不自动配对，须人工确认后才计入完成度。
 */
import type { TakeLog } from '../types/take';
import type { PlanEntry } from '../types/plan';
import { normalizeShotCode } from '../types/plan';

/** 对账差异的四个互斥分类 + 对上 */
export type ReconBucketKey = 'matched' | 'countMismatch' | 'dateMismatch' | 'planOnly' | 'localOnly';

export interface ReconMatched {
  plan: PlanEntry;
  takes: TakeLog[];
  /** 该镜号+日期本机实拍张数合计 */
  localFrames: number;
}

export interface ReconCountMismatch {
  plan: PlanEntry;
  takes: TakeLog[];
  plannedFrames: number;
  localFrames: number;
  /** 正数 = 多拍，负数 = 少拍 */
  diff: number;
}

export interface ReconDateMismatch {
  plan?: PlanEntry;
  take?: TakeLog;
  shotCode: string;
  /** 清单日期（计划侧） */
  planDate?: string;
  /** 本机登记日期 */
  localDate?: string;
  plannedFrames?: number;
  localFrames: number;
}

export interface ReconPlanOnly {
  plan: PlanEntry;
}

export interface ReconLocalOnly {
  take: TakeLog;
}

/** 待复核旧记录恰好能按镜号+日期对上清单：确认后同时把清单标为已对上 */
export interface ReconPendingMatch {
  take: TakeLog;
  plan: PlanEntry;
}

export interface ReconResult {
  matched: ReconMatched[];
  countMismatch: ReconCountMismatch[];
  dateMismatch: ReconDateMismatch[];
  planOnly: ReconPlanOnly[];
  localOnly: ReconLocalOnly[];
  /** v3 旧数据升级后待人工复核的实拍记录（不参与自动配对，不计完成度） */
  pendingReview: TakeLog[];
  /** 待复核记录中能直接对上当日清单条目者 */
  pendingMatched: ReconPendingMatch[];
}

/** 清单里仍参与对账的有效条目（未对账/已对上/张数不符/日期不符/清单独有），已忽略的排除 */
const ACTIVE_PLAN_STATUS = new Set(['未对账', '已对上', '张数不符', '日期不符', '清单独有']);

/**
 * 执行对账：按镜号（规范化后）认本机实拍。
 * 清单镜号在本机零实拍 → 清单独有；镜号有实拍但日期对不上 → 日期不符。
 */
export function reconcile(takes: TakeLog[], plans: PlanEntry[]): ReconResult {
  const result: ReconResult = {
    matched: [],
    countMismatch: [],
    dateMismatch: [],
    planOnly: [],
    localOnly: [],
    pendingReview: [],
    pendingMatched: [],
  };

  // 待复核旧数据单列，绝不自动对上；但记录其镜号+日期，供计划条目提示
  const pendingByCodeDate = new Map<string, TakeLog>();
  const liveTakes = takes.filter((t) => {
    if (t.reconStatus === '待复核') {
      result.pendingReview.push(t);
      pendingByCodeDate.set(`${normalizeShotCode(t.shotCode)}|${t.date}`, t);
      return false;
    }
    return true;
  });

  // 本机实拍按 规范镜号 → 日期 → 记录列表 建索引
  const takeByCodeDate = new Map<string, Map<string, TakeLog[]>>();
  const takeDatesByCode = new Map<string, Set<string>>();
  for (const take of liveTakes) {
    const code = normalizeShotCode(take.shotCode);
    if (!takeByCodeDate.has(code)) takeByCodeDate.set(code, new Map());
    const byDate = takeByCodeDate.get(code) as Map<string, TakeLog[]>;
    const list = byDate.get(take.date) ?? [];
    list.push(take);
    byDate.set(take.date, list);
    if (!takeDatesByCode.has(code)) takeDatesByCode.set(code, new Set());
    takeDatesByCode.get(code)?.add(take.date);
  }

  const consumedTakeIds = new Set<number>();
  const activePlans = plans.filter((p) => ACTIVE_PLAN_STATUS.has(p.reconStatus));

  for (const plan of activePlans) {
    const code = normalizeShotCode(plan.shotCode);
    const pendingHit = pendingByCodeDate.get(`${code}|${plan.date}`);
    if (pendingHit) {
      // 旧记录与清单同日：仅提示可一键确认，不自动入账
      result.pendingMatched.push({ take: pendingHit, plan });
      continue;
    }
    const sameDateTakes = takeByCodeDate.get(code)?.get(plan.date) ?? [];
    if (sameDateTakes.length) {
      const localFrames = sameDateTakes.reduce((sum, t) => sum + (t.takenFrames || 0), 0);
      sameDateTakes.forEach((t) => t.id !== undefined && consumedTakeIds.add(t.id));
      if (localFrames === plan.plannedFrames) {
        result.matched.push({ plan, takes: sameDateTakes, localFrames });
      } else {
        result.countMismatch.push({
          plan,
          takes: sameDateTakes,
          plannedFrames: plan.plannedFrames,
          localFrames,
          diff: localFrames - plan.plannedFrames,
        });
      }
      continue;
    }

    // 同镜号本机在别的日期有实拍 → 日期不符；只是建了镜头但零实拍 → 仍算清单独有
    const codeHasTakes = (takeDatesByCode.get(code)?.size ?? 0) > 0;
    if (codeHasTakes) {
      const candidate = pickDateCandidate(liveTakes, code, plan.date);
      result.dateMismatch.push({
        plan,
        take: candidate,
        shotCode: plan.shotCode,
        planDate: plan.date,
        localDate: candidate?.date,
        plannedFrames: plan.plannedFrames,
        localFrames: candidate?.takenFrames ?? 0,
      });
      if (candidate?.id !== undefined) consumedTakeIds.add(candidate.id);
    } else {
      result.planOnly.push({ plan });
    }
  }

  // 本机有、清单里完全没出现的实拍
  for (const take of liveTakes) {
    if (take.id !== undefined && consumedTakeIds.has(take.id)) continue;
    const code = normalizeShotCode(take.shotCode);
    const stillInPlan = activePlans.some((p) => normalizeShotCode(p.shotCode) === code);
    if (stillInPlan) {
      // 镜号在清单中存在，但该日期的计划条目缺失：归入日期不符
      const planOfCode = activePlans.find((p) => normalizeShotCode(p.shotCode) === code);
      result.dateMismatch.push({
        take,
        shotCode: take.shotCode,
        planDate: planOfCode?.date,
        localDate: take.date,
        plannedFrames: planOfCode?.plannedFrames,
        localFrames: take.takenFrames,
      });
    } else {
      result.localOnly.push({ take });
    }
  }

  sortResult(result);
  return result;
}

/** 日期不符时挑一条最接近计划日期的本机记录展示 */
function pickDateCandidate(takes: TakeLog[], code: string, planDate: string): TakeLog | undefined {
  const sameCode = takes.filter((t) => normalizeShotCode(t.shotCode) === code);
  if (!sameCode.length) return undefined;
  const planTime = Date.parse(`${planDate}T00:00:00`);
  return sameCode
    .slice()
    .sort((a, b) => {
      const da = Math.abs(Date.parse(`${a.date}T00:00:00`) - planTime);
      const db = Math.abs(Date.parse(`${b.date}T00:00:00`) - planTime);
      return da - db || b.updatedAt - a.updatedAt;
    })[0];
}

function sortResult(result: ReconResult): void {
  const byCodeDate = <T extends { plan?: PlanEntry; shotCode?: string; planDate?: string }>(a: T, b: T) => {
    const ca = a.plan?.shotCode ?? a.shotCode ?? '';
    const cb = b.plan?.shotCode ?? b.shotCode ?? '';
    return ca.localeCompare(cb, 'zh-Hans-CN');
  };
  result.matched.sort((a, b) => byCodeDate(a, b));
  result.countMismatch.sort((a, b) => byCodeDate(a, b));
  result.dateMismatch.sort((a, b) => byCodeDate(a, b));
  result.planOnly.sort((a, b) => byCodeDate(a, b));
  result.localOnly.sort((a, b) => a.take.shotCode.localeCompare(b.take.shotCode, 'zh-Hans-CN'));
  result.pendingMatched.sort(
    (a, b) => a.plan.shotCode.localeCompare(b.plan.shotCode, 'zh-Hans-CN') || a.plan.date.localeCompare(b.plan.date),
  );
  result.pendingReview.sort((a, b) => a.date.localeCompare(b.date) || a.shotCode.localeCompare(b.shotCode, 'zh-Hans-CN'));
}