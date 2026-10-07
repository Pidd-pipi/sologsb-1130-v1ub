/**
 * 纯逻辑验证（不依赖 IndexedDB/DOM）：
 *   npx tsx scripts/verify-core.ts
 * 覆盖：对账四分类、旧数据待复核、解析容错、内容指纹幂等。
 */
import { reconcile } from '../src/utils/reconcile';
import { contentBatchId, normalizeDate, parsePlanText } from '../src/utils/planParse';
import type { TakeLog } from '../src/types/take';
import type { PlanEntry, PlanReconStatus } from '../src/types/plan';
import type { Shot } from '../src/types/shot';

let failures = 0;
function assert(cond: boolean, message: string) {
  if (cond) {
    console.log(`  ✓ ${message}`);
  } else {
    failures += 1;
    console.error(`  ✗ ${message}`);
  }
}

const now = 1;
function take(partial: Partial<TakeLog> & { shotCode: string; date: string; takenFrames: number }): TakeLog {
  return {
    id: Math.floor(Math.random() * 1e9),
    shotId: 0,
    wastedFrames: 0,
    remainingFrames: 0,
    percent: 0,
    reconStatus: '未对账',
    updatedAt: now,
    ...partial,
  };
}
function plan(partial: Partial<PlanEntry> & { shotCode: string; date: string; plannedFrames: number }): PlanEntry {
  return {
    id: Math.floor(Math.random() * 1e9),
    batchId: 'b1',
    dedupKey: `b1|${partial.shotCode}|${partial.date}`,
    reconStatus: '未对账' as PlanReconStatus,
    note: '',
    createdAt: now,
    updatedAt: now,
    ...partial,
  };
}
const shots: Shot[] = [
  {
    id: 1,
    code: 'S01',
    sceneName: 'A',
    fps: 24,
    durationSec: 1,
    startFrame: 1,
    endFrame: 24,
    status: '拍摄中',
    owner: '',
    progressPercent: 0,
    createdAt: now,
    updatedAt: now,
  },
];
void shots;

console.log('对账分类：');
{
  const takesList = [
    take({ id: 1, shotCode: 'S01', date: '2026-10-07', takenFrames: 24 }), // 对上
    take({ id: 2, shotCode: 'S02', date: '2026-10-07', takenFrames: 20 }), // 张数不符（本机无此镜头→但有实拍走日期/独有逻辑）
    take({ id: 3, shotCode: 'S03', date: '2026-10-08', takenFrames: 10 }), // 日期不符
    take({ id: 4, shotCode: 'S05', date: '2026-10-07', takenFrames: 9 }), // 本机独有
    take({ id: 5, shotCode: 'S06', date: '2026-10-07', takenFrames: 12, reconStatus: '待复核' }), // 待复核
    take({ id: 6, shotCode: 'S06', date: '2026-10-07', takenFrames: 12 }), // 同日另有未复核记录→正常对上
  ];
  const plansList = [
    plan({ id: 11, shotCode: 'S01', date: '2026-10-07', plannedFrames: 24 }),
    plan({ id: 12, shotCode: 'S02', date: '2026-10-07', plannedFrames: 30 }), // 本机无 S02 镜头但有实拍
    plan({ id: 13, shotCode: 'S03', date: '2026-10-07', plannedFrames: 10 }), // 日期不符
    plan({ id: 14, shotCode: 'S04', date: '2026-10-07', plannedFrames: 16 }), // 清单独有
    plan({ id: 15, shotCode: 'S06', date: '2026-10-07', plannedFrames: 12 }), // 有未复核+正常记录
  ];
  const r = reconcile(takesList, plansList);
  assert(r.matched.length === 1, `对上 1 条（实际 ${r.matched.length}）`);
  assert(r.countMismatch.length === 1 && r.countMismatch[0].diff === -10, 'S02 张数不符且少拍 10');
  assert(r.dateMismatch.some((d) => d.shotCode === 'S03'), 'S03 日期不符单列');
  assert(r.planOnly.some((p) => p.plan.shotCode === 'S04'), 'S04 清单独有');
  assert(r.localOnly.some((l) => l.take.shotCode === 'S05'), 'S05 本机独有');
  assert(r.pendingReview.some((t) => t.id === 5), '旧记录 S06 进待复核');
  assert(r.pendingMatched.some((m) => m.plan.shotCode === 'S06'), 'S06 待复核记录与同日清单出现在待复核-可对上区');
  assert(!r.matched.some((m) => m.takes.some((t) => t.reconStatus === '待复核')), '待复核记录不自动参与对上');
}

console.log('建了镜头但零实拍：')
{
  const r = reconcile([], [plan({ id: 21, shotCode: 'S01', date: '2026-10-07', plannedFrames: 24 })]);
  assert(r.planOnly.length === 1 && r.dateMismatch.length === 0, '只有镜头无实拍不算日期不符，归清单独有，不默认拍完');
}

console.log('镜号规范化：');
{
  const r = reconcile(
    [take({ id: 1, shotCode: 's01', date: '2026-10-07', takenFrames: 24, shotId: 1 })],
    [plan({ id: 11, shotCode: ' S01 ', date: '2026-10-07', plannedFrames: 24 })],
  );
  assert(r.matched.length === 1, '大小写与空格差异不影响镜号认镜头');
}

console.log('清单解析：');
{
  const text = ['镜号,日期,张数,备注', 'S01,2026/10/7,24,主场', 'S02,20261008,12', 'xx,bad,?,坏行'].join('\n');
  const parsed = parsePlanText(text, true);
  assert(parsed.rows.length === 2, `有效 2 行（实际 ${parsed.rows.length}）`);
  assert(parsed.rows[0].date === '2026-10-07' && parsed.rows[1].date === '2026-10-08', '斜杠/紧凑日期归一化');
  assert(parsed.invalid.length === 1, `无效 1 行（实际 ${parsed.invalid.length}）`);

  const noHeader = parsePlanText('S01\t2026-10-07\t24', false);
  assert(noHeader.rows.length === 1 && noHeader.rows[0].plannedFrames === 24, '无表头按固定三列解析');

  assert(normalizeDate('2026.13.1') === null, '非法月份拒绝');
}

console.log('幂等指纹：');
{
  const a = [
    { shotCode: 'S01', date: '2026-10-07', plannedFrames: 24 },
    { shotCode: 'S02', date: '2026-10-08', plannedFrames: 12 },
  ];
  const reordered = [
    { shotCode: 'S02', date: '2026-10-08', plannedFrames: 12 },
    { shotCode: 'S01', date: '2026-10-07', plannedFrames: 24 },
  ];
  assert(contentBatchId(a) === contentBatchId(reordered), '同内容乱序提交批次指纹一致 → 只入账一次');
  const changed = [{ shotCode: 'S01', date: '2026-10-07', plannedFrames: 25 }];
  assert(contentBatchId(a) !== contentBatchId(changed), '张数变化批次指纹不同（允许更正单）');
}

console.log(failures === 0 ? '\n全部通过 ✅' : `\n${failures} 项失败 ❌`);
process.exit(failures === 0 ? 0 : 1);
