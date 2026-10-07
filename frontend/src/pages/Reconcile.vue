<script setup lang="ts">
/**
 * 排片清单对账：导入棚里另一套排片系统导出的清单（CSV/JSON），
 * 按镜号认到本机镜头后分四类列出（对上 / 张数不符 / 日期不符 / 本机无镜号），
 * 不默认算拍完：全部先待复核，确认后对上的实拍才并入完成度。
 * 同一份清单重复提交由批次唯一键去重。
 */
import { computed, onMounted, ref } from 'vue';
import { storeToRefs } from 'pinia';
import { useShotStore } from '../stores/shotStore';
import { useReconcile } from '../hooks/useReconcile';
import { formatDateTime, today } from '../utils/format';
import EmptyState from '../components/common/EmptyState.vue';
import { RECONCILE_STATUS_LABEL } from '../types/manifest';
import type { ManifestRowInput } from '../types/manifest';
import type { PlanItem, ReconcileStatus } from '../types/manifest';

const shotStore = useShotStore();
const { shots } = storeToRefs(shotStore);
const {
  batches,
  groups,
  counts,
  selectedBatchId,
  loading,
  feedback,
  pendingTakeIds,
  previewFile,
  load,
  importBatch,
  confirmItem,
  confirmGroup,
  resetItem,
  createShotForItem,
  removeBatch,
  reevaluate,
  confirmPendingTakes,
} = useReconcile();

const fileName = ref('');
const fallbackDate = ref(today());
const previewRows = ref<ManifestRowInput[]>([]);
const previewErrors = ref<string[]>([]);
const previewName = ref('');
const importing = ref(false);
const fileInput = ref<HTMLInputElement | null>(null);

const totalVisible = computed(
  () => counts.value.matched + counts.value.countMismatch + counts.value.dateMismatch + counts.value.shotMissing + counts.value.reviewed,
);

const SECTIONS: { key: 'matched' | 'countMismatch' | 'dateMismatch' | 'shotMissing'; title: string; tone: string }[] = [
  { key: 'matched', title: '对上（镜号 / 日期 / 张数一致）', tone: 'ok' },
  { key: 'countMismatch', title: '张数对不上（多拍 / 少拍）', tone: 'warn' },
  { key: 'dateMismatch', title: '日期对不上', tone: 'warn' },
  { key: 'shotMissing', title: '清单有、本机没有的镜号', tone: 'err' },
];

onMounted(async () => {
  await shotStore.load();
  await load();
});

async function onFile(e: Event) {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  fileName.value = file.name;
  const text = await file.text();
  const result = previewFile(file.name, text, fallbackDate.value);
  previewRows.value = result.rows;
  previewErrors.value = result.errors;
  previewName.value = result.batchName;
}

async function doImport() {
  if (!previewRows.value.length) return;
  importing.value = true;
  try {
    await importBatch(previewName.value || `清单 ${fallbackDate.value}`, fileName.value || '手工粘贴', previewRows.value);
    previewRows.value = [];
    previewErrors.value = [];
    previewName.value = '';
    fileName.value = '';
    if (fileInput.value) fileInput.value.value = '';
  } finally {
    importing.value = false;
  }
}

function clearPreview() {
  previewRows.value = [];
  previewErrors.value = [];
  previewName.value = '';
  fileName.value = '';
  if (fileInput.value) fileInput.value.value = '';
}

function shotCodeOf(item: PlanItem): string {
  if (item.shotId === null) return '';
  return shots.value.find((s) => s.id === item.shotId)?.code ?? item.shotCode;
}

function batchName(batchId: number): string {
  return batches.value.find((b) => b.id === batchId)?.name ?? `批次 #${batchId}`;
}

const statusBadge: Record<ReconcileStatus, string> = {
  unreconciled: 'badge gray',
  matched: 'badge green',
  countMismatch: 'badge amber',
  dateMismatch: 'badge amber',
  shotMissing: 'badge red',
  reviewed: 'badge blue',
};
</script>

<template>
  <section class="page">
    <header class="page-head">
      <div>
        <h1>排片清单对账</h1>
        <p class="sub">导入另一套排片系统收工导出的清单，按镜号与本机实拍记录核对；对上的张数确认后才并入完成度，差异分列、不默认算拍完</p>
      </div>
      <div class="head-actions">
        <button type="button" class="btn" data-testid="re-reconcile" @click="reevaluate">按当前实拍重新对账</button>
      </div>
    </header>

    <div v-if="feedback" :class="['feedback', feedback.type === 'ok' ? 'ok' : 'err']" data-testid="reconcile-feedback">
      {{ feedback.text }}
    </div>

    <div v-if="pendingTakeIds.length" class="panel pending-banner" data-testid="pending-takes-banner">
      <div>
        <strong>有 {{ pendingTakeIds.length }} 条旧实拍记录处于待复核</strong>
        <p class="muted">旧数据升级时统一先按未对账处理，确认前不计入任何镜头完成度。</p>
      </div>
      <button type="button" class="btn primary" data-testid="confirm-pending-takes" @click="confirmPendingTakes">全部确认并重算</button>
    </div>

    <div class="panel">
      <div class="panel-head"><h2>导入清单</h2><span class="muted">支持 CSV（含表头：镜号 / 日期 / 计划张数）或 JSON 数组</span></div>
      <div class="import-grid">
        <label class="field grow">
          <span>清单文件（.csv / .json）</span>
          <input ref="fileInput" type="file" accept=".csv,.json,text/csv,application/json" data-testid="manifest-file" @change="onFile" />
        </label>
        <label class="field">
          <span>批次日期（行内无日期时兜底）</span>
          <input v-model="fallbackDate" type="date" data-testid="manifest-date" />
        </label>
      </div>
      <p class="muted tiny">示例 CSV 表头：<code>镜号,日期,计划张数</code>，如 <code>S01,2026-10-07,24</code>。同一份清单重复提交会自动去重。</p>

      <div v-if="previewErrors.length" class="parse-errors" data-testid="parse-errors">
        <div v-for="(msg, i) in previewErrors" :key="i" class="parse-err">{{ msg }}</div>
      </div>

      <div v-if="previewRows.length" class="preview" data-testid="import-preview">
        <div class="preview-head">
          <strong>{{ previewName }}：待导入 {{ previewRows.length }} 条</strong>
          <div class="actions">
            <button type="button" class="btn primary" :disabled="importing" data-testid="import-submit" @click="doImport">
              {{ importing ? '导入中…' : '导入并对账' }}
            </button>
            <button type="button" class="btn" @click="clearPreview">取消</button>
          </div>
        </div>
        <table class="table">
          <thead><tr><th>镜号</th><th>日期</th><th>计划张数</th></tr></thead>
          <tbody>
            <tr v-for="(r, i) in previewRows.slice(0, 50)" :key="i">
              <td class="mono">{{ r.shotCode }}</td>
              <td class="mono">{{ r.plannedDate }}</td>
              <td>{{ r.plannedFrames }}</td>
            </tr>
          </tbody>
        </table>
        <p v-if="previewRows.length > 50" class="muted tiny">仅预览前 50 行，导入包含全部 {{ previewRows.length }} 条。</p>
      </div>
    </div>

    <div class="panel">
      <div class="panel-head">
        <h2>对账结果</h2>
        <div class="filters">
          <label class="inline-field">
            批次：
            <select v-model="selectedBatchId" data-testid="batch-select">
              <option value="all">全部批次（{{ batches.length }}）</option>
              <option v-for="b in batches" :key="b.id" :value="b.id">{{ b.name }} · {{ b.itemCount }} 条</option>
            </select>
          </label>
        </div>
      </div>

      <div class="stat-row compact">
        <div class="stat min"><span class="label">对上</span><span class="value green">{{ counts.matched }}</span></div>
        <div class="stat min"><span class="label">张数不符</span><span class="value amber">{{ counts.countMismatch }}</span></div>
        <div class="stat min"><span class="label">日期不符</span><span class="value amber">{{ counts.dateMismatch }}</span></div>
        <div class="stat min"><span class="label">本机无镜号</span><span class="value red">{{ counts.shotMissing }}</span></div>
        <div class="stat min"><span class="label">已复核</span><span class="value blue">{{ counts.reviewed }}</span></div>
      </div>

      <EmptyState
        v-if="!totalVisible"
        title="还没有清单"
        description="在上方选择另一套排片系统导出的 CSV 或 JSON 清单，导入后这里按四类分列差异。"
      />

      <template v-else>
        <section v-for="sec in SECTIONS" :key="sec.key" class="result-block">
          <div class="block-head">
            <h3 :class="sec.tone">{{ sec.title }} <span class="count-pill">{{ counts[sec.key] }}</span></h3>
            <button
              v-if="groups[sec.key].length"
              type="button"
              class="btn small"
                  :data-testid="`confirm-group-${sec.key}`"
              @click="confirmGroup(sec.key)"
            >
              {{ sec.key === 'matched' ? '整组确认并计入完成度' : '整组标记差异已知悉' }}
            </button>
          </div>
          <table v-if="groups[sec.key].length" class="table" :data-testid="`table-${sec.key}`">
            <thead>
              <tr>
                <th>批次</th><th>清单镜号</th><th v-if="sec.key !== 'shotMissing'">本机镜号</th>
                <th>清单日期</th><th>清单张数</th>
                <th v-if="sec.key === 'countMismatch'">本机实拍</th>
                <th v-if="sec.key === 'dateMismatch'">本机记录日期</th>
                <th>说明</th><th>操作</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="item in groups[sec.key]" :key="item.id">
                <td class="muted">{{ batchName(item.batchId) }}</td>
                <td class="mono">{{ item.shotCode }}</td>
                <td v-if="sec.key !== 'shotMissing'" class="mono">{{ shotCodeOf(item) }}</td>
                <td class="mono">{{ item.plannedDate }}</td>
                <td>{{ item.plannedFrames }}</td>
                <td v-if="sec.key === 'countMismatch'">
                  <span :class="{ 'num-bad': (item.actualFrames ?? 0) !== item.plannedFrames }">{{ item.actualFrames ?? '-' }}</span>
                </td>
                <td v-if="sec.key === 'dateMismatch'" class="mono">{{ item.actualDate ?? '-' }}</td>
                <td class="muted note-cell">{{ item.note }}</td>
                <td class="op-cell">
                  <button v-if="sec.key === 'shotMissing'" type="button" class="btn small" @click="createShotForItem(item)">补建镜头</button>
                  <button
                    v-else
                    type="button"
                    class="btn small primary"
                    @click="confirmItem(item)"
                  >{{ sec.key === 'matched' ? '确认并计入' : '差异已知悉' }}</button>
                </td>
              </tr>
            </tbody>
          </table>
          <p v-else class="muted tiny">无</p>
        </section>

        <section v-if="groups.reviewed.length" class="result-block">
          <div class="block-head"><h3 class="blue">已复核 <span class="count-pill">{{ groups.reviewed.length }}</span></h3></div>
          <table class="table" data-testid="table-reviewed">
            <thead><tr><th>批次</th><th>镜号</th><th>日期</th><th>清单 / 实拍</th><th>结论</th><th>操作</th></tr></thead>
            <tbody>
              <tr v-for="item in groups.reviewed" :key="item.id">
                <td class="muted">{{ batchName(item.batchId) }}</td>
                <td class="mono">{{ item.shotCode }}</td>
                <td class="mono">{{ item.plannedDate }}</td>
                <td>{{ item.plannedFrames }} / {{ item.actualFrames ?? '—' }}</td>
                <td><span :class="statusBadge[item.status]">{{ RECONCILE_STATUS_LABEL[item.status] }}</span></td>
                <td><button type="button" class="btn small" @click="resetItem(item)">撤回复核</button></td>
              </tr>
            </tbody>
          </table>
        </section>
      </template>
    </div>

    <div v-if="batches.length" class="panel">
      <div class="panel-head"><h2>已导入批次</h2><span class="muted">{{ loading ? '读取中…' : '删除批次不影响本机实拍记录' }}</span></div>
      <table class="table" data-testid="batch-table">
        <thead><tr><th>批次</th><th>来源文件</th><th>日期</th><th>条目</th><th>导入时间</th><th>操作</th></tr></thead>
        <tbody>
          <tr v-for="b in batches" :key="b.id">
            <td>{{ b.name }}</td>
            <td class="muted">{{ b.sourceName }}</td>
            <td class="mono">{{ b.batchDate }}</td>
            <td>{{ b.itemCount }}</td>
            <td class="muted">{{ formatDateTime(b.createdAt) }}</td>
            <td><button type="button" class="btn small danger" @click="removeBatch(b)">删除批次</button></td>
          </tr>
        </tbody>
      </table>
    </div>
  </section>
</template>

<style scoped>
.page { display: flex; flex-direction: column; gap: 16px; }
.page-head { display: flex; justify-content: space-between; align-items: flex-end; gap: 12px; }
h1 { margin: 0; font-size: 22px; }
.sub { margin: 4px 0 0; color: #6b7686; font-size: 13px; }
.head-actions { display: flex; gap: 10px; }
.panel { background: #fff; border: 1px solid #e2e7ef; border-radius: 10px; padding: 16px; }
.panel-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; gap: 10px; flex-wrap: wrap; }
.panel-head h2 { margin: 0; font-size: 16px; }
.import-grid { display: flex; gap: 12px; flex-wrap: wrap; }
.field { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: #5a6472; }
.field.grow { flex: 1; min-width: 240px; }
.field input, .inline-field select { height: 32px; border: 1px solid #cfd6e0; border-radius: 6px; padding: 0 8px; font-size: 13px; background: #fff; color: #1f2d3d; }
.inline-field { font-size: 12px; color: #5a6472; display: inline-flex; align-items: center; gap: 6px; }
.actions { display: flex; gap: 8px; }
.muted { color: #8a94a6; font-size: 12px; }
.tiny { font-size: 11px; }
.muted code { background: #f2f4f8; border-radius: 4px; padding: 1px 4px; }
.parse-errors { margin-top: 10px; display: flex; flex-direction: column; gap: 4px; }
.parse-err { font-size: 12px; color: #b25b00; background: #fff7e8; border: 1px solid #ffe2ad; border-radius: 6px; padding: 5px 8px; }
.preview { margin-top: 12px; border-top: 1px solid #eef1f6; padding-top: 12px; }
.preview-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; font-size: 13px; flex-wrap: wrap; gap: 8px; }
.pending-banner { display: flex; justify-content: space-between; align-items: center; gap: 12px; background: #fff8ec; border-color: #f0d9a8; }
.pending-banner p { margin: 4px 0 0; }
.feedback { margin: 0; border-radius: 8px; padding: 8px 12px; font-size: 13px; }
.feedback.ok { background: #eef6ff; border: 1px solid #d3e4ff; color: #24559c; }
.feedback.err { background: #fdeeee; border: 1px solid #f3c9c9; color: #a23b3b; }
.stat-row { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 10px; margin-bottom: 12px; }
.stat { border: 1px solid #e6eaf1; border-radius: 8px; padding: 10px 12px; display: flex; flex-direction: column; gap: 2px; }
.stat.min { align-items: flex-start; }
.stat .label { font-size: 12px; color: #6b7686; }
.stat .value { font-size: 22px; font-weight: 700; }
.value.green, h3.ok, .green { color: #2e8b57; }
.value.amber, h3.warn, .amber { color: #b27416; }
.value.red, h3.err, .red { color: #c45656; }
.value.blue, h3.blue, .blue { color: #2f6fed; }
.result-block { margin-top: 14px; border-top: 1px dashed #e6eaf1; padding-top: 12px; }
.block-head { display: flex; justify-content: space-between; align-items: center; gap: 10px; margin-bottom: 8px; flex-wrap: wrap; }
.block-head h3 { margin: 0; font-size: 14px; display: inline-flex; align-items: center; gap: 8px; }
.count-pill { background: #eef1f6; border-radius: 10px; font-size: 11px; padding: 1px 8px; color: #5a6472; font-weight: 600; }
.table { width: 100%; border-collapse: collapse; font-size: 13px; }
.table th, .table td { text-align: left; padding: 8px 6px; border-bottom: 1px solid #eef1f6; vertical-align: top; }
.table th { color: #6b7686; font-weight: 600; font-size: 12px; }
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.note-cell { max-width: 260px; }
.op-cell { white-space: nowrap; }
.num-bad { color: #c45656; font-weight: 600; }
.badge { display: inline-block; border-radius: 10px; padding: 1px 9px; font-size: 11px; }
.badge.green { background: #e6f5ec; color: #2e8b57; }
.badge.amber { background: #fdf2dd; color: #b27416; }
.badge.red { background: #fde9e9; color: #c45656; }
.badge.blue { background: #e8f0fe; color: #2f6fed; }
.badge.gray { background: #eef1f6; color: #6b7686; }
.btn { height: 32px; padding: 0 14px; border-radius: 6px; border: 1px solid #cfd6e0; background: #fff; color: #1f2d3d; cursor: pointer; font-size: 13px; }
.btn:disabled { opacity: 0.6; cursor: default; }
.btn.primary { background: #2f6fed; border-color: #2f6fed; color: #fff; }
.btn.small { height: 28px; padding: 0 10px; font-size: 12px; }
.btn.danger { color: #c45656; border-color: #f0c8c8; }
</style>
