# Route B Product Surface Audit And Handoff

## Design Classification
- task_type: design-audit
- scope_fit: in-scope
- primary_surface: homepage / primary navigation / stress-lab result page / Review Board layering
- audit_basis:
  - `docs/plans/2026-03-31-product-surface-note.md`
  - `docs/plans/2026-03-31-prompt-2-handoff.md`
  - `docs/plans/2026-03-31-prompt-3-handoff.md`
  - `docs/plans/2026-04-01-prompt-4-handoff.md`
  - `docs/plans/2026-03-31-direction-decision-memo.md`
  - `docs/plans/2026-03-31-wave-1-delivery-note.md`
  - `docs/plans/2026-04-01-wave-2-delivery-note.md`
  - `apps/command-center/src/App.tsx`
  - `apps/command-center/src/components/ConsoleHeader.tsx`
  - `apps/command-center/src/components/HelpPanel.tsx`
  - `apps/command-center/src/components/OnboardingTour.tsx`
  - `apps/command-center/src/views/QuickLaunchView.tsx`
  - `apps/command-center/src/views/ReviewBoardView.tsx`
  - `apps/command-center/src/components/CommandGrid.tsx`
  - `packages/orchestrator/src/commands/catalog.ts`
  - `packages/orchestrator/src/commands/run/profile-finalize.ts`

## Route B Product Surface Note

### One-sentence shift

Route B 这轮要把产品主语从“治理与决策工作台”切成“给任意 URL 发起浏览器实验，并读懂实验结果的压力实验室”。

### What changes in plain language

现在的前台更像一个运营中控台：它一直在教用户先去 `Quick Launch`，再去 `Task Center`，最后去 `Review Board` 做证据比对。  
Route B 不该只是把首页标题改成 stress lab，因为那样用户点进去以后，整条走廊还是会把他带回治理/决策叙事。

Route B 本轮应该改成下面这条主线：

1. 用户先输入或确认目标 URL。
2. 用户再选“要做哪一类实验”。
3. 用户进入单次实验结果页，看见像实验室报告一样的结果摘要、风险、样本与报告入口。
4. 只有当用户已经需要更深比对、历史对照、AI 摘要、proof campaign 时，才进入增强层。

### Route B homepage story

首页不是“平台里有哪些房间”，而是“我现在要对这个 URL 做什么实验”。

首页应回答四个问题：

1. 目标是谁：当前正在测哪个 URL / target。
2. 能做什么：`load / perf / explore / chaos / visual / a11y` 六个一级能力。
3. 怎么开始：选能力、调关键参数、启动实验。
4. 做完去哪看：进入单次 result page，而不是先教育用户什么是 Review Board。

### Route B primary IA

本轮推荐把一级 IA 改成两层，而不是继续用 lane-first 叙事。

#### Layer 1: start experiment

- URL / target entry
- capability navigation
- launch configuration

#### Layer 2: read result

- latest run summary
- capability-specific findings
- artifacts and report links
- next actions

#### Enhanced layer

- Review Board
- release brief
- similar failures
- proof campaign / compare
- manual gate / governance-specific reading

这层要保留，但要从“首页默认目的地”退成“结果页里的深挖入口”。

## Key Findings

### Confirmed alignment

- Route B 已被确认执行，且 Prompt 5 之后才处理 branding / SEO / public demo / growth。
- 仓库里 `load / perf / explore / chaos / a11y / visual` 是真实能力，不是文案幻想。
- 结果产物也是真实存在的：`reports/summary.json`、`metrics/load-summary.json`、`a11y/axe.json`、`perf/lighthouse.json`、`visual/report.json`、`explore/report.json`、`chaos/report.json`。
- Route B 最低成本路径已经被方向 memo 明确为“复用现有 substrate，改产品叙事而不是推翻底层”。

### Core drift

当前 drift 不是视觉风格，而是主语 drift。

- Header、Help、Onboarding、Quick Launch 文案都仍在反复强化 `Quick Launch -> Task Center -> Flow Workshop -> Review Board`。
- 一级导航是 lane-first，不是 capability-first。
- Review Board 仍然是完整一级页签，且帮助体系把它定义成核心路径终点。
- 结果阅读目前被分散在 Task Center、Flow Workshop、Review Board，而不是收束成“单次实验报告页”。
- CommandGrid 的分类仍是 `init / pipeline / frontend / automation / maintenance / backend`，不服务 Route B 的能力心智。

### Handoff completeness

- 已足够支持本轮 implementer 切片。
- 不需要新增 API / schema 才能定义本轮首页、导航与结果面重排。
- 真正需要谨慎的是测试负担：Wave 1 已把首跑引导、Help、Header、Review Board 测试都绑在 lane-first 文案上。

### Evidence limits

- 本轮没有浏览器截图或像素级视觉证据。
- 结论主要来自现有文档与表层文案/信息结构证据，因此视觉置信度为中等，IA 置信度为高。

## Prioritized Drift / Gap List

| 优先级 | 类别 | 问题 | 用户可见影响 | 建议动作 | 置信度 |
| --- | --- | --- | --- | --- | --- |
| HIGH | 结构漂移 | 首页仍以 lane-first 入口为主 | 用户第一眼看到的是“去哪个房间”，不是“测哪个 URL / 做什么实验” | 把首页改成 URL-first + capability-first 入口 | high |
| HIGH | 交互漂移 | 一级导航仍是 `launch/tasks/workshop/review` | Route B 主语没有真正切换，只是旧叙事上叠新词 | 让一级导航先表达能力与结果，再把 Review Board 降为增强层 | high |
| HIGH | 交接完整性缺口 | 没有单次 stress-lab result page 规格 | implementer 会继续把结果散落在 Task Center / Review Board | 定义 result page 的固定信息结构与 next-action hierarchy | high |
| MEDIUM | 状态漂移 | Review Board 仍被解释为主线终点 | 用户会误以为所有实验都必须进入 governance board | 把 Review Board 改成 result page 的“advanced analysis”入口 | high |
| MEDIUM | 模式复用缺口 | CommandGrid 分类服务工程命令，不服务能力心智 | Capability nav 容易被误做成新页面而不是复用现有命令卡片 | 基于现有命令卡片做能力分组包装，避免大改底层 | medium |
| MEDIUM | 文案漂移 | README / get-started / help/onboarding 仍在讲 operator journey | docs 主语和 UI 主语不一致，像前门写咖啡馆、进门却是实验室 | 本轮同步 docs 主语到 URL-first stress lab | high |
| LOW | 视觉证据缺口 | 尚无真实截图核对层级与密度 | 视觉 polish 易被过度想象 | 先做 IA 与内容层切片，视觉延续现有 design language | medium |

## Thin Slice

### This round must achieve

本轮的 thin slice 不是完整 stress-lab brand，而是先把“人一进来看到什么、点哪里开始、结果怎么看、Review Board 退到哪层”说清并落到 UI。

### Thin slice boundary

- 做：产品入口、一级能力导航、结果页信息结构、Review Board 降层、docs 主语同步。
- 不做：品牌包装、SEO 文案、公共 demo、增长页面、全新视觉系统、全新后端领域扩张。

## Must-Do UI / IA Actions This Round

### 1. 把首页改成 URL-first 入口

首页首屏必须先出现目标 URL / target，而不是先出现 lane map。

#### Required structure

- `Target input` 作为首要输入，名称建议偏用户任务而不是内部参数名。
- 首屏要显示“当前 target / 最近 target / 推荐 local target”之一，避免空白起步。
- 目标 URL 下方紧跟一句 outcome-led 描述，例如“选择要对这个 URL 做哪类实验”。

#### Why this is mandatory

如果还先展示 lane map，主语就还是“这个平台有哪些区域”，不是“我要测这个网址”。

### 2. 把一级能力导航改成 capability-first

一级能力导航必须明确到这 6 个能力：

- `load`
- `perf`
- `explore`
- `chaos`
- `visual`
- `a11y`

#### Interaction rule

- 用户先选能力，再看到对应的关键参数与推荐启动方式。
- 能力导航可以复用现有 `CommandGrid` / command catalog，但对外不能继续以工程分类 `init/pipeline/frontend/...` 作为主导航语义。
- 能力卡只展示 1 句用户结果导向说明，不展示太多治理术语。

#### Capability copy rule

- `load`: 压力、吞吐、失败请求、延迟分位
- `perf`: 页面性能、LCP/FCP/加载体验
- `explore`: 页面状态扫描、路径发现、脆弱点排查
- `chaos`: 扰动、随机交互、脆弱性暴露
- `visual`: 视觉回归、差异截图、版面偏移
- `a11y`: 严重无障碍问题、标准扫描结果

### 3. 新主结果面必须像实验室报告，不像 governance board

本轮必须定义并落一个主结果面。它可以是新页，也可以是把当前 `Task Center` 重组为 result-first 视图，但用户感知必须是“实验报告页”。

#### Recommended information order

1. `Run header`
   - target URL
   - selected capability
   - run status
   - started / finished time
2. `Lab verdict`
   - 一句话结论
   - 2-4 个关键指标/风险 badge
3. `Capability summary`
   - 按当前能力展示最重要的 3-6 个字段
4. `Evidence and artifacts`
   - summary report
   - raw report path / downloadable artifact
   - log / screenshot / trace / compare entry
5. `Recommended next action`
   - rerun
   - switch capability
   - open advanced analysis

#### What it must not feel like

- 不能一上来就是 compare runs / proof campaign / release brief。
- 不能要求用户先理解 governed evidence 才能看懂结果。
- 不能把“结果页”做成多个治理模块的拼盘。

### 4. 保留 Review Board，但降成增强层

Review Board 不删，但它的职责要后撤。

#### New role

- 默认不是首页主导航终点。
- 从 result page 进入，作为 “Advanced analysis” / “Compare and proof”。
- 只在以下场景被强调：
  - 要对比两个 runs
  - 要读 AI release brief
  - 要查 similar failures
  - 要保存 proof campaign

#### Copy rule

所有文案都要改成：

- “当你已经有实验结果、并且要做更深比较时再进入”
- 而不是
- “标准主流程的最后一步”

### 5. 同步 docs 主语

本轮 docs 必须跟 UI 同步，不然前门和室内会讲两种语言。

#### Minimum doc sync

- `README.md`
- `docs/get-started.md`
- `docs/why-pagestress.md`
- `docs/proof-center.md`

#### Doc rule

- 首页与快速开始必须先讲 URL-first + capability-first。
- Review Board 与 proof language 放在增强分析段落，不再作为首个推荐主线。

## UI State Matrix

| Surface | State | Type | What user sees | Notes |
| --- | --- | --- | --- | --- |
| Homepage target entry | pristine | local interaction | 空输入或默认 target 提示 | 若有默认 local target，可预填但需允许覆盖 |
| Homepage target entry | invalid URL / missing required target | local interaction | 阻止启动，显示具体校验提示 | 仅定义表层行为，不发明后端校验规则 |
| Capability nav | no capability selected | local interaction | 强调“先选实验类型” | 不自动跳 Review Board |
| Capability nav | capability selected | local interaction | 显示对应关键参数和启动 CTA | 复用现有命令/模板载体 |
| Launch | loading | local interaction | CTA loading，准备 run | 延续现有按钮 loading 模式 |
| Launch | start failure | contract-driven | 启动失败提示 + retry | 错误文案来自已有 API 错误，不新增语义 |
| Result page | loading | local interaction | “实验结果生成中”骨架屏 | 不展示 governance 术语 |
| Result page | empty / no run yet | local interaction | 指引回到首页选 URL 和能力启动 | 这是 Route B 的关键空态 |
| Result page | success | contract-driven | 显示 verdict、关键指标、报告入口 | 当前能力决定展示字段 |
| Result page | failed / partial | contract-driven | 显示失败原因、已生成证据、推荐下一步 | 不强制跳 Review Board |
| Result page | advanced analysis collapsed | local interaction | 只显示一个增强层入口 | 默认收起 |
| Review Board enhanced layer | no eligible runs | contract-driven | 解释“先完成实验，再做 compare/proof” | 退为增强层后的空态 |
| Review Board enhanced layer | ready | contract-driven | compare / AI brief / similar failures / proof campaign | 保留已有 Wave 2 能力 |

## Must Have

- 首页第一优先级是 target URL / target context，而不是 lane education。
- 一级导航必须是六个能力，不是四个房间。
- 主结果面必须先给单次实验结论，再给深挖入口。
- Review Board 必须保留，但默认后置。
- docs 主语必须和 UI 一起切换。
- 现有 design language、组件与 loading/error/empty pattern 尽量复用。

## Must Not Have

- 不把 Route B 做成一次品牌改版。
- 不把首页做成 governance board 的换皮。
- 不把 Review Board、AI brief、proof campaign 删除。
- 不新增一套与现有 App 平行的第二导航系统。
- 不为了能力导航重写整套命令执行底层。
- 不忽视现有测试锚点和 a11y 文案成本。

## Reusable Patterns / Constraints

### Patterns to keep

- 现有 `Card`、`Button`、`Badge`、loading card、empty state 结构可继续复用。
- 当前 `QuickLaunchView` 已经有参数区、命令卡、模板卡，可以作为 URL-first 首页的载体。
- 当前 `ReviewBoardView` 的 compare / release brief / similar failures / feasibility 已是可用增强层素材。

### Constraints to keep

- `AppView` 目前只有 `launch / tasks / workshop / review` 四个主视图，说明本轮切片优先考虑重命名/重组现有视图，而不是无限扩路由。
- Wave 1 和 Wave 2 已经把很多测试绑定在 lane-first copy 上，本轮应预计同步更新：
  - `ConsoleHeader.a11y.test.tsx`
  - `QuickLaunchView.firstuse.test.tsx`
  - `OnboardingTour.a11y.test.tsx`
  - `HelpPanel.test.tsx`
  - `ReviewBoardView.test.tsx`
  - 以及相关 a11y / waiting-state 测试

## Can Defer After This Round

- Flow Workshop 在 Route B 下的重新定位文案
- 更细的 capability-specific advanced panels
- richer AI review grouping / severity UI
- deeper Manual Gate inbox/workbench UX
- retrieval 结果的更强可操作化
- capability 对应的精细化推荐参数 presets

这些项重要，但不会阻塞“主语已经切换”的第一轮产品感知。

## Prompt 5 Items

- branding / visual marketing polish
- SEO / homepage distribution copy
- public demo packaging
- public-safe growth storytelling
- 更外向的竞争定位与 hero wording

这些都应等到本轮入口、导航、结果面、docs 主语稳定后再做。

## What Implementer Should Fix First

- first_fix: `QuickLaunchView` 及相关 header/help/onboarding 的首页叙事改成 URL-first + capability-first
- second_fix: 用现有 run/result 数据把 `Task Center` 或同级视图改造成 stress-lab result page
- third_fix: 把 `Review Board` 改成 result page 的增强层入口与文案，而不是主线终点
- fourth_fix: 同步 docs front door 到 Route B 主语
- can_defer: Flow Workshop 深化、AI/retrieval 更复杂展示、品牌/SEO/public demo

## Implementation Guardrails

- 优先复用现有 `QuickLaunchView`、`CommandGrid`、`TaskCenterView`、`ReviewBoardView` 骨架，不新开大面积平行体系。
- capability-first 应该是“对外导航语义重组”，不是把底层 command registry 改造成另一套 truth source。
- Review Board 的 Wave 2 能力全部保留，只改可见层级和入口位置。
- 结果页先做单 run report center，不要一开始就设计成 multi-run governance cockpit。
- 若某些字段无法稳定支撑 capability summary，先显示现有 summary/report path，不脑补新指标。

## Verification Focus

- 首屏在 5 秒扫读内能否回答：“我测哪个 URL、做哪类实验、从哪开始？”
- 一级导航是否已经从 lane-first 变为 capability-first。
- 单次 result page 是否先给实验结论，而不是先给治理功能。
- Review Board 是否仍可访问，但默认不喧宾夺主。
- README / get-started / in-app help / onboarding 是否已讲同一种主语。
- 回归测试是否覆盖被改动的 lane copy 与导航文案。

## Audit Confidence

- visual: text-inference
- overall: high
- note: IA、主语切换、增强层定位的证据很强；视觉层级与密度没有截图支持，因此不输出像素级规格。

## Risks / Open Questions

- 若 implementer 选择“新增整页 Stress Lab 路由”而不是重组现有 `launch/tasks/review`，测试与信息架构变动会显著扩大。
- `Flow Workshop` 在 Route B 下是继续保留一级入口，还是并入结果页的 advanced tools，本轮可以先不裁决。
- 若需要 capability-specific 更深指标面板，下一轮要先核对 API 与当前 run artifact 投影是否足够稳定。
