/**
 * IndexedDB 持久化层（Dexie 封装）。
 * 库名 gbstopmotion-db，含版本号与升级迁移：
 *   v1 建 shots / frames
 *   v2 增加 props 表与 shotId 索引
 *   v3 增加 takes 表，并按实拍张数回填进度
 *   v4 增加 manifestBatches / planItems（外部排片清单对账）；
 *      takes 增加 reviewStatus：旧数据一律先按未对账归入待复核，
 *      完成度只统计 confirmed，确认后才并回。
 */
import Dexie from 'dexie';
import type { Table } from 'dexie';
import type { Shot } from '../types/shot';
import type { FrameEntry } from '../types/frame';
import type { PropState } from '../types/prop';
import type { TakeLog } from '../types/take';
import type { ManifestBatch, PlanItem } from '../types/manifest';

export const DB_NAME = 'gbstopmotion-db';

/**
 * 脱代理：Pinia 里的对象是 Proxy，直接写进 IndexedDB 会抛 DataCloneError。
 * 这里统一做一次结构化克隆后的纯对象转换。
 */
export function toPlain<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  try {
    return JSON.parse(JSON.stringify(value)) as T;
  } catch {
    return value;
  }
}

export class StopMotionDb extends Dexie {
  shots!: Table<Shot, number>;
  frames!: Table<FrameEntry, number>;
  props!: Table<PropState, number>;
  takes!: Table<TakeLog, number>;
  manifestBatches!: Table<ManifestBatch, number>;
  planItems!: Table<PlanItem, number>;

  constructor() {
    super(DB_NAME);
    this.version(1).stores({
      shots: '++id, code, status, sceneName',
      frames: '++id, shotId, frameNo, [shotId+frameNo]',
    });
    this.version(2)
      .stores({
        shots: '++id, code, status, sceneName',
        frames: '++id, shotId, frameNo, [shotId+frameNo]',
        props: '++id, shotId, name, [shotId+fromFrame]',
      })
      .upgrade(async (tx) => {
        // v2：为已有帧补齐道具位移字段，保证轨迹页可直接读取
        await tx
          .table('frames')
          .toCollection()
          .modify((row: Record<string, unknown>) => {
            if (typeof row.propOffsetMm !== 'number') row.propOffsetMm = 0;
          });
      });
    this.version(3)
      .stores({
        shots: '++id, code, status, sceneName',
        frames: '++id, shotId, frameNo, [shotId+frameNo]',
        props: '++id, shotId, name, [shotId+fromFrame]',
        takes: '++id, shotId, date, shotCode',
      })
      .upgrade(async (tx) => {
        // v3：按已登记的实拍张数回填完成百分比
        const takes = await tx.table('takes').toCollection().toArray();
        const shots = await tx.table('shots').toCollection().toArray();
        for (const take of takes) {
          const shot = shots.find((s: Record<string, unknown>) => s.id === take.shotId);
          if (!shot || typeof shot.durationSec !== 'number' || typeof shot.fps !== 'number') continue;
          const total = Math.max(1, Math.ceil(shot.durationSec * shot.fps));
          const percent = Math.min(100, Math.round((take.takenFrames / total) * 100));
          await tx.table('takes').update(take.id, { percent });
        }
      });
    this.version(4)
      .stores({
        shots: '++id, code, status, sceneName',
        frames: '++id, shotId, frameNo, [shotId+frameNo]',
        props: '++id, shotId, name, [shotId+fromFrame]',
        // reviewStatus 加入 takes 索引，便于待复核视图过滤
        takes: '++id, shotId, date, shotCode, reviewStatus',
        // batchKey 唯一索引（&）：同一份清单重复提交第二次直接被拦，同一批张数不算两遍
        manifestBatches: '++id, &batchKey, createdAt',
        planItems: '++id, batchId, shotId, status, shotCodeKey, [batchId+shotCodeKey], reviewed',
      })
      .upgrade(async (tx) => {
        // v4：旧实拍数据先按未对账归入待复核，确认后才并入完成度。
        // 已有进度快照同步清零，避免总览页在复核前继续把旧账算成已完成。
        await tx
          .table('takes')
          .toCollection()
          .modify((row: Record<string, unknown>) => {
            if (row.reviewStatus !== 'confirmed') row.reviewStatus = 'pending';
          });
        await tx
          .table('shots')
          .toCollection()
          .modify((row: Record<string, unknown>) => {
            if (row.progressPercent !== undefined) row.progressPercent = 0;
          });
      });
  }
}

export const db = new StopMotionDb();
