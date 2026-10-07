<script setup lang="ts">
/**
 * 排片清单对账台。
 * 导入棚里另一套排片系统导出的清单（CSV/TSV），按镜号与本机实拍记录核对：
 * 已对上 / 张数不符 / 日期不符 / 清单独有 四类分列，本机独有与待复核旧数据单列；
 * 任何确认动作都按实际已核实张数重算镜头完成度，不默认算拍完。
 */
import { computed, onMounted, ref } from 'vue';
import { useShotStore } from '../stores/shotStore';
import { useReconcile } from '../hooks/useReconcile';
import { formatDateTime } from '../utils/format';
import EmptyState from '../components/common/EmptyState.vue';
import type { PlanRowInput } from '../types/plan';

const shotStore = useShotStore();
const {
  result,
  loading,
  importing,
  lastImport,
  hasDiscrepancy,
  loadAll,
  preview,
  importRows,
  applyReconcile,
  confirmMatched,
  acceptActualCount,
  resolveDateByActual,
  resolveDateByPlan,
  confirmDateTake,
  ignorePlan,
  confirmLocalTake,
  confirmPendingReview,
  confirmPendingMatched,
  discardPendingReview,
} = useReconcile();

const rawText = ref('');
const hasHeader = ref(true);
const previewRows = ref<PlanRowInput[]>([]);
const previewInvalid = ref<{ lineNo: number; raw: string; reason: string }[]>([]);
const feedback = ref('');
const previewTouched = ref(false);

const counts = computed(() => ({
  matched: result.value.matched.length,
  countMismatch: result.value.countMismatch.length,
  dateMismatch: result.value.dateMismatch.length,
  planOnly: result.value.planOnly.length,
  localOnly: result.value.localOnly.length,
  pending: result.value.pendingReview.length,
}));

onMounted(async () => {
  if (!shotStore.ready) await shotStore.load();
  await loadAll();
});

function flash(text: string) {
  feedback.value = text;
  window.setTimeout(() => {
    if (feedback.value === text) feedback.value = '';
  }, 4000);
}

function updatePreview() {
  const parsed = preview(rawText.value, hasHeader.value);
  previewRows.value = parsed.rows;
  previewInvalid.value = parsed.invalid;
  previewTouched.value = rawText.value.trim().length > 0;
}

function loadSample() {
  rawText.value = ['镜号\t日期\t张数\t备注', 'S01\t2026-10-07\t24\t示例', 'S02\t2026/10/7\t12\t示例'].join('\n');
  updatePreview();
}

async function doImport() {
  if (!previewRows.value.length) {
    flash('没有可导入的有效行，请检查清单格式（镜号 / 日期 / 张数）');
    return;
  }
  const summary = await importRows(previewRows.value);
  if (summary.duplicated > 0) {
    flash(`导入完成：新增 ${summary.inserted} 条，${summary.duplicated} 条与已提交清单重复，已自动跳过（同一批不重复计张数）`);
  } else {
    flash(`导入完成：新增 ${summary.inserted} 条${summary.invalid ? `，${summary.invalid} 行无法解析已丢弃` : ''}，已自动对账`);
  }
  rawText.value = '';
  previewRows.value = [];
  previewInvalid.value = [];
  previewTouched.value = false;
}

async function runReconcile() {
  await applyReconcile();
  flash('对账状态已写回，各镜头完成度已按实际张数重算');
}

async function act(task: (() => Promise<void>) | Promise<void>, message: string) {
  await (typeof task === 'function' ? task() : task);
  flash(message);
}
</script>

<template>
  <section class="page">
    <header class="page-head">
      <div>
        <h1>排片清单对账</h1>
        <p class="sub">把棚里另一套排片系统导出的清单贴进来，按镜号与本机实拍核对张数与日期</p>
      </div>
      <div class="stat-inline">
        <span>已对上 <strong class="ok">{{ counts.matched }}</strong></span>
        <span>待处理差异 <strong :class="{ warn: hasDiscrepancy }">{{ hasDiscrepancy ? counts.countMismatch + counts.dateMismatch + counts.planOnly + counts.localOnly + counts.pending : 0 }}</strong></span>
      </div>
    </header>

    <p v-if="feedback" class="feedback" data-testid="recon-feedback">{{ feedback }}</p>

    <div class="panel">
      <div class="panel-head">
        <h2>① 导入清单</h2>
        <span class="muted">支持 CSV / TSV，列顺序：镜号、日期、计划张数（首行可为表头）</span>
      </div>
      <textarea
        v-model="rawText"
        class="paste"
        rows="6"
        placeholder="镜号&#9;日期&#9;张数&#10;S01&#9;2026-10-07&#9;24&#10;S02&#9;2026/10/7&#9;12"
        data-testid="recon-paste"
        @input="updatePreview"
      ></textarea>
      <div class="import-bar">
        <label class="check"><input v-model="hasHeader" type="checkbox" @change="updatePreview" /> 首行是表头</label>
        <button type="button" class="btn tiny" @click="loadSample">填入示例</button>
        <span class="muted" v-if="previewTouched">
          识别到 <strong>{{ previewRows.length }}</strong> 行有效
          <span v-if="previewInvalid.length" class="err">，{{ previewInvalid.length }} 行无效</span>
        </span>
        <span class="spacer"></span>
        <button
          type="button"
          class="btn primary"
          :disabled="importing || !previewRows.length"
          data-testid="recon-import"
          @click="doImport"
        >
          {{ importing ? '导入中…' : '导入并对账' }}
        </button>
      </div>
      <table v-if="previewInvalid.length" class="table invalid-table" data-testid="recon-invalid">
        <thead>
          <tr><th>行号</th><th>原始内容</th><th>问题</th></tr>
        </thead>
        <tbody>
          <tr v-for="row in previewInvalid" :key="row.lineNo">
            <td class="mono">{{ row.lineNo }}</td>
            <td class="mono">{{ row.raw }}</td>
            <td class="err">{{ row.reason }}</td>
          </tr>
        </tbody>
      </table>
    </div>

    <div v-if="loading" class="panel muted">读取中…</div>

    <template v-else>
      <!-- 待复核：v3 旧数据升级后先归入这里，确认后才并进完成度 -->
      <div v-if="counts.pending" class="panel pending" data-testid="recon-pending">
        <div class="panel-head">
          <h2>② 待复核（旧实拍数据，升级时未自动并入完成度）</h2>
          <span class="tag tag-pending">{{ counts.pending }} 条</span>
        </div>
        <table class="table">
          <thead>
            <tr><th>镜号</th><th>日期</th><th>实拍张数</th><th>清单张数</th><th>登记时间</th><th>操作</th></tr>
          </thead>
          <tbody>
            <tr v-for="m in result.pendingMatched" :key="m.take.id" class="row-match">
              <td class="mono">{{ m.take.shotCode }}</td>
              <td class="mono">{{ m.take.date }}</td>
              <td>{{ m.take.takenFrames }}</td>
              <td>{{ m.plan.plannedFrames }}</td>
              <td class="muted">{{ formatDateTime(m.take.updatedAt) }}</td>
              <td class="row-actions">
                <button
                  type="button"
                  class="btn tiny primary"
                  data-testid="pending-match-confirm"
                  @click="act(confirmPendingMatched(m.take.id as number, m.plan.id as number), '旧记录与清单一致，已确认对上并并入完成度')"
                >
                  与清单一致，确认并入
                </button>
                <button
                  type="button"
                  class="btn tiny danger"
                  @click="act(discardPendingReview(m.take.id as number), '该条旧记录核实为误登，已删除')"
                >
                  误登删除
                </button>
              </td>
            </tr>
            <tr v-for="t in result.pendingReview.filter((x) => !result.pendingMatched.some((m) => m.take.id === x.id))" :key="t.id">
              <td class="mono">{{ t.shotCode }}</td>
              <td class="mono">{{ t.date }}</td>
              <td>{{ t.takenFrames }}</td>
              <td class="muted">无当日清单</td>
              <td class="muted">{{ formatDateTime(t.updatedAt) }}</td>
              <td class="row-actions">
                <button
                  type="button"
                  class="btn tiny primary"
                  data-testid="pending-confirm"
                  @click="act(confirmPendingReview(t.id as number), `已确认 ${t.shotCode} 的旧记录，张数已并入完成度`)"
                >
                  确认并入
                </button>
                <button
                  type="button"
                  class="btn tiny danger"
                  @click="act(discardPendingReview(t.id as number), '该条旧记录核实为误登，已删除')"
                >
                  误登删除
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <div class="panel">
        <div class="panel-head">
          <h2>③ 对账结果</h2>
          <div class="head-actions">
            <span class="muted" v-if="lastImport">最近批次 {{ lastImport.batchId }}：新增 {{ lastImport.inserted }} · 跳过重复 {{ lastImport.duplicated }}</span>
            <button type="button" class="btn small" data-testid="recon-rerun" @click="runReconcile">重新对账并写回状态</button>
          </div>
        </div>

        <div class="bucket-grid">
          <div class="bucket ok">
            <strong>{{ counts.matched }}</strong>
            <span>已对上</span>
          </div>
          <div class="bucket warn">
            <strong>{{ counts.countMismatch }}</strong>
            <span>张数不符</span>
          </div>
          <div class="bucket warn">
            <strong>{{ counts.dateMismatch }}</strong>
            <span>日期不符</span>
          </div>
          <div class="bucket warn">
            <strong>{{ counts.planOnly }}</strong>
            <span>清单有 / 本机无</span>
          </div>
          <div class="bucket info">
            <strong>{{ counts.localOnly }}</strong>
            <span>本机有 / 清单无</span>
          </div>
        </div>

        <EmptyState
          v-if="!counts.matched && !hasDiscrepancy && !counts.pending"
          title="还没有对账数据"
          description="在上方粘贴排片清单并导入；或先到实拍记录页登记当日张数。"
        />

        <!-- 已对上 -->
        <section v-if="counts.matched" class="bucket-block" data-testid="bucket-matched">
          <h3><span class="dot dot-ok"></span>已对上（镜号、日期、张数一致）</h3>
          <table class="table">
            <thead>
              <tr><th>镜号</th><th>日期</th><th>计划/实拍</th><th>批次</th><th>操作</th></tr>
            </thead>
            <tbody>
              <tr v-for="m in result.matched" :key="m.plan.id">
                <td class="mono">{{ m.plan.shotCode }}</td>
                <td class="mono">{{ m.plan.date }}</td>
                <td>{{ m.plan.plannedFrames }} / {{ m.localFrames }} 张</td>
                <td class="muted">{{ m.plan.batchId }}</td>
                <td>
                  <button
                    type="button"
                    class="btn tiny"
                    @click="act(confirmMatched(m.plan.id as number, m.takes.map((t) => t.id as number)), '已确认对上')"
                  >
                    确认
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
        </section>

        <!-- 张数不符 -->
        <section v-if="counts.countMismatch" class="bucket-block" data-testid="bucket-count">
          <h3><span class="dot dot-warn"></span>张数不符（完成度按本机实际张数重算，不默认拍完）</h3>
          <table class="table">
            <thead>
              <tr><th>镜号</th><th>日期</th><th>计划</th><th>本机实拍</th><th>差异</th><th>操作</th></tr>
            </thead>
            <tbody>
              <tr v-for="m in result.countMismatch" :key="m.plan.id">
                <td class="mono">{{ m.plan.shotCode }}</td>
                <td class="mono">{{ m.plan.date }}</td>
                <td>{{ m.plannedFrames }}</td>
                <td>{{ m.localFrames }}</td>
                <td :class="m.diff > 0 ? 'over' : 'under'">
                  {{ m.diff > 0 ? `多拍 ${m.diff}` : `少拍 ${-m.diff}` }} 张
                </td>
                <td class="row-actions">
                  <button
                    type="button"
                    class="btn tiny primary"
                    data-testid="count-accept"
                    @click="act(acceptActualCount(m.plan.id as number, m.takes.map((t) => t.id as number)), '已按本机实际张数确认并重算完成度')"
                  >
                    按实际 {{ m.localFrames }} 张确认
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
        </section>

        <!-- 日期不符 -->
        <section v-if="counts.dateMismatch" class="bucket-block" data-testid="bucket-date">
          <h3><span class="dot dot-warn"></span>日期不符（镜号认得到，拍摄日期对不上）</h3>
          <table class="table">
            <thead>
              <tr><th>镜号</th><th>清单日期</th><th>本机日期</th><th>计划/实拍</th><th>操作</th></tr>
            </thead>
            <tbody>
              <tr v-for="(d, i) in result.dateMismatch" :key="d.plan?.id ?? `d-${i}`">
                <td class="mono">{{ d.shotCode }}</td>
                <td class="mono">{{ d.planDate ?? '—' }}</td>
                <td class="mono">{{ d.localDate ?? '—' }}</td>
                <td>{{ d.plannedFrames ?? '—' }} / {{ d.localFrames }} 张</td>
                <td class="row-actions">
                  <template v-if="d.plan && d.take">
                    <button
                      type="button"
                      class="btn tiny primary"
                      data-testid="date-actual"
                      @click="act(resolveDateByActual(d.plan.id as number, d.take.id as number), '已按本机实拍日期确认，张数并入完成度')"
                    >
                      以实拍日期为准
                    </button>
                    <button
                      type="button"
                      class="btn tiny"
                      @click="act(resolveDateByPlan(d.plan.id as number, d.take.id as number), '已标记以计划为准，请更正本机实拍日期')"
                    >
                      以计划为准
                    </button>
                  </template>
                  <button
                    v-else-if="d.plan"
                    type="button"
                    class="btn tiny"
                    @click="act(ignorePlan(d.plan.id as number), '该清单条目已忽略')"
                  >
                    忽略（撤拍/改期）
                  </button>
                  <button
                    v-else-if="d.take"
                    type="button"
                    class="btn tiny primary"
                    @click="act(confirmDateTake(d.take.id as number), '已确认该条实拍有效，张数并入完成度')"
                  >
                    确认实拍 {{ d.localFrames }} 张
                  </button>
                  <span v-else class="muted">该日期无计划条目</span>
                </td>
              </tr>
            </tbody>
          </table>
        </section>

        <!-- 清单独有 -->
        <section v-if="counts.planOnly" class="bucket-block" data-testid="bucket-plan-only">
          <h3><span class="dot dot-warn"></span>清单里有、本机没拍到（镜号未认到或零实拍，未计入任何完成度）</h3>
          <table class="table">
            <thead>
              <tr><th>镜号</th><th>日期</th><th>计划张数</th><th>备注</th><th>操作</th></tr>
            </thead>
            <tbody>
              <tr v-for="p in result.planOnly" :key="p.plan.id">
                <td class="mono">{{ p.plan.shotCode }}</td>
                <td class="mono">{{ p.plan.date }}</td>
                <td>{{ p.plan.plannedFrames }}</td>
                <td class="muted">{{ p.plan.note || '—' }}</td>
                <td>
                  <button
                    type="button"
                    class="btn tiny danger"
                    data-testid="plan-ignore"
                    @click="act(ignorePlan(p.plan.id as number), '已忽略该清单条目')"
                  >
                    忽略（撤拍）
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
        </section>

        <!-- 本机独有 -->
        <section v-if="counts.localOnly" class="bucket-block" data-testid="bucket-local-only">
          <h3><span class="dot dot-info"></span>本机有实拍、清单里没有镜号</h3>
          <table class="table">
            <thead>
              <tr><th>镜号</th><th>日期</th><th>实拍张数</th><th>废帧</th><th>操作</th></tr>
            </thead>
            <tbody>
              <tr v-for="l in result.localOnly" :key="l.take.id">
                <td class="mono">{{ l.take.shotCode }}</td>
                <td class="mono">{{ l.take.date }}</td>
                <td>{{ l.take.takenFrames }}</td>
                <td>{{ l.take.wastedFrames }}</td>
                <td>
                  <button
                    type="button"
                    class="btn tiny primary"
                    @click="act(confirmLocalTake(l.take.id as number), `已确认 ${l.take.shotCode} 为本机实拍，张数继续计入完成度`)"
                  >
                    确认实拍
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
        </section>
      </div>
    </template>
  </section>
</template>

<style scoped>
.page {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.page-head {
  display: flex;
  justify-content: space-between;
  align-items: flex-end;
  gap: 12px;
}
h1 {
  margin: 0;
  font-size: 22px;
}
h2 {
  margin: 0;
  font-size: 16px;
}
h3 {
  margin: 18px 0 8px;
  font-size: 14px;
  display: flex;
  align-items: center;
  gap: 8px;
}
.sub {
  margin: 4px 0 0;
  color: #6b7686;
  font-size: 13px;
}
.stat-inline {
  display: flex;
  gap: 14px;
  font-size: 13px;
  color: #5a6472;
}
.stat-inline strong {
  font-size: 18px;
  margin-left: 4px;
}
.stat-inline .ok {
  color: #3aa675;
}
.stat-inline .warn {
  color: #c47f17;
}
.panel {
  background: #fff;
  border: 1px solid #e2e7ef;
  border-radius: 10px;
  padding: 16px;
}
.panel.pending {
  border-color: #f0d9a8;
  background: #fffaef;
}
.panel-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 12px;
}
.head-actions {
  display: flex;
  gap: 10px;
  align-items: center;
}
.paste {
  width: 100%;
  box-sizing: border-box;
  border: 1px solid #cfd6e0;
  border-radius: 8px;
  padding: 10px;
  font-size: 13px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  resize: vertical;
}
.import-bar {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 10px;
}
.spacer {
  flex: 1;
}
.check {
  font-size: 13px;
  color: #5a6472;
  display: flex;
  align-items: center;
  gap: 4px;
}
.bucket-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(130px, 1fr));
  gap: 10px;
}
.bucket {
  border: 1px solid #e2e7ef;
  border-radius: 10px;
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 2px;
  background: #fafbfd;
}
.bucket strong {
  font-size: 22px;
}
.bucket span {
  font-size: 12px;
  color: #6b7686;
}
.bucket.ok strong {
  color: #3aa675;
}
.bucket.warn strong {
  color: #c47f17;
}
.bucket.info strong {
  color: #2f6fed;
}
.tag {
  font-size: 12px;
  border-radius: 999px;
  padding: 2px 10px;
}
.tag-pending {
  background: #f7e3b8;
  color: #8a5a12;
}
.dot {
  width: 9px;
  height: 9px;
  border-radius: 50%;
  display: inline-block;
}
.dot-ok {
  background: #3aa675;
}
.dot-warn {
  background: #d99b2b;
}
.dot-info {
  background: #2f6fed;
}
.table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}
.table th,
.table td {
  text-align: left;
  padding: 8px 6px;
  border-bottom: 1px solid #eef1f6;
}
.table th {
  color: #6b7686;
  font-weight: 600;
  font-size: 12px;
}
.invalid-table {
  margin-top: 10px;
}
.row-match {
  background: #f1faf5;
}
.mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}
.muted {
  color: #8a94a6;
  font-size: 12px;
}
.over {
  color: #c45656;
}
.under {
  color: #c47f17;
}
.err {
  color: #c45656;
}
.row-actions {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}
.btn {
  height: 32px;
  padding: 0 14px;
  border-radius: 6px;
  border: 1px solid #cfd6e0;
  background: #fff;
  color: #1f2d3d;
  cursor: pointer;
  font-size: 13px;
}
.btn.primary {
  background: #2f6fed;
  border-color: #2f6fed;
  color: #fff;
}
.btn.small {
  height: 28px;
  padding: 0 10px;
  font-size: 12px;
}
.btn.tiny {
  height: 24px;
  padding: 0 8px;
  font-size: 12px;
}
.btn.danger {
  color: #c45656;
  border-color: #f0c8c8;
}
.btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.feedback {
  margin: 0;
  background: #eef6ff;
  border: 1px solid #d3e4ff;
  color: #24559c;
  border-radius: 8px;
  padding: 8px 12px;
  font-size: 13px;
}
</style>
