/**
 * Dexie 层验证（fake-indexeddb）：
 *   npx tsx scripts/verify-db.ts
 * 覆盖：
 *  1. 同一份清单并发双提交（模拟两个标签页几乎同时提交）→ 只入账一次，张数不重算两遍；
 *  2. 同镜号+日期新批次导入 → 旧批次同键条目让位为「已忽略」；
 *  3. v4 升级语义：待复核不进完成度，确认后并入并重算剩余/百分比。
 */
import 'fake-indexeddb/auto';
import { db } from '../src/db/index';
import * as api from '../src/db/api';
import { contentBatchId } from '../src/utils/planParse';
import { takeCountsTowardProgress } from '../src/types/take';
import { recomputeShotProgress } from '../src/services/progress';
import type { Shot } from '../src/types/shot';
import type { TakeLog } from '../src/types/take';

let failures = 0;
function assert(cond: boolean, message: string) {
  if (cond) console.log(`  ✓ ${message}`);
  else {
    failures += 1;
    console.error(`  ✗ ${message}`);
  }
}

async function makeShot(code: string, durationSec = 1, fps = 24): Promise<number> {
  const shot: Shot = {
    code,
    sceneName: '测试',
    fps,
    durationSec,
    startFrame: 1,
    endFrame: Math.ceil(durationSec * fps),
    status: '拍摄中',
    owner: '',
    progressPercent: 0,
    createdAt: 1,
    updatedAt: 1,
  };
  return api.addShot(shot);
}

async function main() {
  await db.open();

  console.log('并发/重复提交幂等：');
  {
    const rows = [
      { shotCode: 'S01', date: '2026-10-07', plannedFrames: 24 },
      { shotCode: 'S02', date: '2026-10-07', plannedFrames: 12 },
    ];
    const batchId = contentBatchId(rows);
    // 模拟两边几乎同时提交同一批
    const [r1, r2] = await Promise.all([api.importPlanRows(rows, batchId), api.importPlanRows(rows, batchId)]);
    const all = await api.listPlanEntries();
    assert(r1.inserted + r2.inserted === 2, `总共只写入 2 条（${r1.inserted}/${r2.inserted}）`);
    assert(r1.duplicated + r2.duplicated === 2, `重复条目被跳过 2 次（${r1.duplicated}/${r2.duplicated}）`);
    assert(all.length === 2, `库里清单条目正好 2 条（实际 ${all.length}），同批张数未算两遍`);

    // 再串行提交一次同样内容
    const r3 = await api.importPlanRows(rows, batchId);
    assert(r3.inserted === 0 && r3.duplicated === 2, '重复导入整批跳过');
  }

  console.log('更正单替换同键旧条目：');
  {
    const fixed = [{ shotCode: 'S01', date: '2026-10-07', plannedFrames: 25 }];
    const fixedBatch = contentBatchId(fixed);
    await api.importPlanRows(fixed, fixedBatch);
    const all = await api.listPlanEntries();
    const s01 = all.filter((p) => p.shotCode === 'S01');
    const active = s01.filter((p) => p.reconStatus !== '已忽略');
    assert(s01.length === 2, 'S01 存在新旧两条批次记录');
    assert(active.length === 1 && active[0].plannedFrames === 25, '旧批次同键条目已让位，只以新计划 25 张参与对账');
  }

  console.log('旧数据待复核 → 确认后并入：');
  {
    const shotId = await makeShot('S10', 1, 24);
    const legacy: TakeLog = {
      date: '2026-10-07',
      shotCode: 'S10',
      shotId,
      takenFrames: 12,
      wastedFrames: 0,
      remainingFrames: 24,
      percent: 50,
      reconStatus: '待复核',
      updatedAt: 1,
    };
    const takeId = await api.addTake(legacy);
    assert(!takeCountsTowardProgress('待复核'), '待复核状态不纳入完成度');

    let recalc = (await recomputeShotProgress(shotId))!;
    assert(recalc.taken === 0 && recalc.percent === 0, '未确认前完成度为 0，剩余 24（不默认拍完）');

    await api.updateTakeRecon([takeId], { reconStatus: '已确认' });
    recalc = (await recomputeShotProgress(shotId))!;
    assert(recalc.taken === 12 && recalc.percent === 50 && recalc.remaining === 12, '确认后按实际 12 张重算：50%，剩余 12');

    // 张数变化（多拍）后再重算
    await api.updateTake(takeId, { takenFrames: 30 });
    recalc = (await recomputeShotProgress(shotId))!;
    assert(recalc.taken === 30 && recalc.percent === 100 && recalc.remaining === 0, '实际张数变为 30 后重算为 100%，剩余 0');
  }

  console.log(failures === 0 ? '\n全部通过 ✅' : `\n${failures} 项失败 ❌`);
  await db.close();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
