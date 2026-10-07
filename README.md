# 定格动画拍摄帧序编排台（gbstopmotion）

面向定格动画的动画师与摄影助理，把镜头拆分、逐帧位移量与拍摄参数记录成可执行的拍摄清单：新建镜头后按帧率与时长自动排帧区间，在帧序条带上插入、删除、移动帧并重算时长，随拍随记曝光参数与实拍张数。

## Docker 一键启动

```bash
cp .env.example .env
docker compose up -d --build
```

启动后访问：<http://localhost:21830>

停止（镜像保留）：

```bash
docker compose down
```

## 对账逻辑自检

```bash
cd frontend && npm install && npm run verify
```

`scripts/verify-core.ts`（纯函数：四分类、旧数据待复核、清单解析、内容指纹）与
`scripts/verify-db.ts`（fake-indexeddb：同批并发双提交只入账一次、更正单替换、待复核确认后重算）。

## 技术栈

| 层 | 选型 |
| --- | --- |
| 框架 | Vue 3（`<script setup>` + TypeScript） |
| 构建 | Vite 5 + `vue-tsc -b`（类型检查零错误） |
| 状态 | Pinia（`shotStore` / `frameStore` / `uiStore`） |
| 路由 | Vue Router 4（HTML5 History，nginx `try_files` 兜底） |
| UI | Element Plus + 自研轻量组件 |
| 本地存储 | IndexedDB（Dexie，库名 `gbstopmotion-db`）+ localStorage（表单草稿） |
| 托管 | nginx:alpine（多阶段构建，gzip + 前端路由回落） |

## 目录结构

```
sologsb-1130/
├── docker-compose.yml        # 顶层 name: gbstopmotion，端口 ${FRONTEND_PORT:-21830}
├── .env / .env.example       # COMPOSE_PROJECT_NAME=gbstopmotion
└── frontend/
    ├── Dockerfile            # node:20-alpine 构建 → nginx:alpine 托管
    ├── nginx.conf            # try_files $uri $uri/ /index.html + gzip
    ├── public/favicon.svg
    └── src/
        ├── types/{shot,frame,prop,take,plan}.ts        # 5 个数据模型（plan 为外部排片清单）
        ├── stores/{shotStore,frameStore,uiStore}.ts
        ├── components/common/{FrameStrip,ExposureForm,ShotProgress,StatusTag,EmptyState}.vue
        ├── hooks/{useFrameSequence,useProgress,useLocalDraft,useReconcile}.ts
        ├── pages/{Overview,ShotNew,ShotDetail,FrameBoard,PropTrack,TakeLog,Reconcile}.vue
        ├── router/index.ts
        ├── utils/{frameMath,exposure,format,reconcile,planParse}.ts
        ├── services/progress.ts                       # 已核实张数重算完成度/剩余
        └── db/{index,api}.ts                          # Dexie 实例（v1→v4 升级迁移）与读写层
```

## 页面与路由

| 路由 | 页面 | 说明 |
| --- | --- | --- |
| `/` | 进度总览 | 各镜头状态、帧数、预计时长、完成百分比，累计全片张数与待拍张数 |
| `/shots/new` | 新建镜头 | 填写镜号、场景名、帧率与时长，保存后生成帧区间与首位帧条目 |
| `/shots/:id` | 镜头详情 | 镜头参数与进度、帧序条带、帧条目表格、道具轨迹、登记实拍 |
| `/frames` | 帧序编排台 | 移动/插入/删除帧、批量套用曝光，改动后重算序号与总时长 |
| `/props` | 道具位移轨迹 | 按镜头与帧区间登记 X/Y/Z 与旋转角度，曲线预览累计位移 |
| `/progress` | 实拍记录 | 登记当日实拍张数与废帧数，回写完成百分比并提示剩余张数 |
| `/reconcile` | 清单对账 | 导入外部排片清单（CSV/TSV），按镜号对账：对上/张数不符/日期不符/清单独有分列 |

## 数据存储

- **IndexedDB（Dexie，`gbstopmotion-db`）**：镜头、帧条目、道具状态、实拍记录、排片清单五张表。
  版本迁移：`v1` 建 `shots` / `frames`；`v2` 增加 `props` 表与 `shotId` 索引；`v3` 增加 `takes` 表并按实拍张数回填进度；`v4` 增加 `planEntries` 表、`takes` 增加对账状态与唯一幂等键，旧实拍记录一律置为「待复核」、镜头完成度清零，人工确认后才并入。
- **清单对账规则**：按规范镜号（忽略大小写/空白）+ 日期匹配；张数/日期不一致与「清单有本机无」分四类列出，不默认算拍完；只有 已对上/张数不符（按实际）/本机独有/未对账/已确认 的记录计入完成度，待复核与日期不符须先处理。
- **导入幂等**：批次号由清单内容指纹（FNV-1a）派生，配合 `dedupKey` 唯一索引与事务冲突重试；同一份清单重复或几乎同时提交，同一批（镜号+日期）张数只入账一次。
- **localStorage**：新建镜头表单与批量曝光参数草稿，键前缀 `gbstopmotion:draft:`。
- 全部数据存在浏览器本地，容器无状态、不使用数据库服务、不挂载命名卷，无任何后端接口调用。
