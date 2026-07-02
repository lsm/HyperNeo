# HyperNeo UI/UX 升级方案 v1.0.0

> **设计哲学基准**：日本美学七原则 × Apple Human Interface Guidelines
> **版本**：1.0.0 | **日期**：2026-03-19 | **状态**：草案

---

## 目录

1. [深度现状评估](#1-深度现状评估)
2. [核心问题诊断](#2-核心问题诊断)
3. [设计哲学框架](#3-设计哲学框架)
4. [信息架构重设计](#4-信息架构重设计)
5. [核心 UX 改造：任务确认中心化](#5-核心-ux-改造任务确认中心化)
6. [视觉语言系统](#6-视觉语言系统)
7. [组件级重设计](#7-组件级重设计)
8. [交互动效规范](#8-交互动效规范)
9. [响应式与移动端](#9-响应式与移动端)
10. [实施路线图](#10-实施路线图)

---

## 1. 深度现状评估

### 1.1 技术基础

| 层面 | 现状 |
|------|------|
| 框架 | Preact 10.29 + @preact/signals |
| 样式 | TailwindCSS v4 + 自定义 dark-* 调色板 |
| 构建 | Vite 7 |
| 布局模型 | NavRail(64px) + ContextPanel(280px) + MainContent(flex-1) |
| 主题 | 纯深色模式，dark-950 → dark-700 五级灰阶 |

### 1.2 导航层级拆解（实测）

```
全局导航 NavRail
├── Home   → Lobby（大厅）
├── Rooms  → ContextPanel: RoomList / RoomContextPanel
│   └── [选中 Room] → Room.tsx
│       ├── Tab: Overview → RoomDashboard
│       │   └── RoomTasks (tab: Active / Review / Done / Needs Attention)
│       │       └── TaskItem → [点击] → TaskView
│       │           ├── HeaderReviewBar (仅 submittedForReview=true 时显示)
│       │           ├── 3-dot Dropdown → Mark Complete / Cancel Task
│       │           └── HumanInputArea
│       ├── Tab: Context
│       ├── Tab: Agents
│       ├── Tab: Missions (GoalsEditor)
│       └── Tab: Settings
├── Chats  → ContextPanel: SessionList → ChatContainer
└── Settings → ContextPanel: 设置分类列表
```

**导航深度**：最深路径为 5 层（NavRail → Room → Tab → TaskItem → TaskView → Dropdown）

### 1.3 任务操作分散点定位（Bug 级问题）

经过代码级审查，**任务确认/审批/完成操作**分布在以下 5 个位置：

| 位置 | 组件 | 触发条件 | 操作 |
|------|------|----------|------|
| ① TaskView 顶部 amber 条 | `HeaderReviewBar` | `group.submittedForReview === true` | Approve / Reject |
| ② TaskView header 三点菜单 | `Dropdown` → `CompleteTaskDialog` | `canComplete` | Mark as Complete |
| ③ TaskView header 三点菜单 | `Dropdown` → `CancelTaskDialog` | `canCancel` | Cancel Task |
| ④ RoomDashboard Review Tab | `TaskItem` inline button | `task.status === 'review'` | Approve (→ ConfirmModal) |
| ⑤ RoomDashboard Review Tab | `TaskItem` inline button | `task.status === 'review'` | View |

**核心问题**：
- Approve 操作存在**两条路径**（④ 和 ①），流程不一致：④ 用通用 ConfirmModal，① 用专用 HeaderReviewBar
- Complete 操作**藏在 3-dot 下拉菜单**中，用户无法直觉发现
- 无全局"待我处理"汇聚视图，任务审批需要深入到具体 TaskView 才能操作
- Review 状态的 badge/count 仅在 RoomTasks tab 标题上显示，NavRail 无任何提示

### 1.4 视觉系统问题

- **品牌标识**：Logo 为 🤖 emoji，缺乏品牌识别度
- **按钮样式不一致**：部分使用 `Button` 组件（含 variant 系统），部分使用原始 `button` + 手写 Tailwind
- **确认对话框不统一**：ReviewBar 中的 Approve/Reject 为内联按钮，CompleteTaskDialog 为 Modal，ConfirmModal 为另一种 Modal
- **色彩语义混乱**：amber = 等待审核，purple = review，green = approve，这三者语义重叠
- **层级对比度不足**：dark-950/900/850/800 之间视觉差异极小，区域划分模糊

---

## 2. 核心问题诊断

### P0 — 任务行动流程碎片化

**问题**：用户需要执行「确认任务完成」「批准/驳回 review」「处理问题任务」时，操作入口分散在多个不同位置，且未经显著标识。

**影响**：核心工作流受阻，用户遗漏 review 请求，任务卡在 review 状态。

### P0 — 缺乏全局「需要我关注」层

**问题**：没有一个统一视图能看到所有需要用户介入的任务（review、needs_attention）。

**影响**：用户必须逐一进入每个 Room 的 Review tab 才能发现待处理项。

### P1 — 主导航与子导航信息架构混乱

**问题**：NavRail 的 Home 和 Rooms 功能高度重叠（都显示 Room 列表）；Room 内 Missions tab 名称与代码中的 Goals 不一致；Settings 在 NavRail 和 Room 内各有一个。

### P1 — 视觉层级系统缺失

**问题**：五级灰阶（dark-950~700）对比度差异不足，用户难以区分内容层级；缺乏明确的「主操作」视觉引导。

### P2 — 品牌与视觉识别度低

**问题**：🤖 emoji logo、无主题色系统、组件样式不一致。

---

## 3. 设计哲学框架

### 3.1 日本美学七原則

#### 間（Ma）— 呼吸感

> 「間」は「無」ではなく、「意味ある余白」である

界面的每个元素都需要足够的呼吸空间。组件之间的留白不是「空白」，而是传递「当前没有需要你注意的事」这一信息。

**应用**：
- 空状态（empty states）使用充足的垂直白空间 + 单一居中图标，不堆砌文字
- 任务列表行间距从当前 `py-3` 提升至 `py-4`，给每条任务以存在感
- 面板内容区域使用 24px 内边距（vs 当前 16px）

#### 簡素（Kanso）— 减法哲学

> 本質以外をすべて取り除く

每个界面只呈现用户**当前上下文**所需的信息，多余的一切被隐藏。

**应用**：
- TaskView 中，当任务 `status === 'pending'`，不显示 Approve/Reject 操作区
- Room Dashboard 将 Sessions 列表移入侧边栏，主内容区专注 Tasks
- NavRail 的 Home 和 Rooms 合并为单一入口

#### 侘寂（Wabi-sabi）— 过程之美

> 完璧ではなく、変化の中に美を見出す

任务状态的转换（pending → in_progress → review → completed）应该感觉像一个自然的生命历程，而非机械的状态机。

**应用**：
- 完成动画：轻微的绿色粒子效果（非弹窗）
- 任务完成后，在列表中以 strikethrough + fade 方式留存 2 秒再移入 Done tab
- 错误状态不用警告红色轰炸，用温和的 `needs_attention` 橙色

#### 静寂（Seijaku）— 宁静基调

> 動きは意味を持つときにのみ存在する

静止状态是默认态，动画/动效只在有实质意义时出现。

**应用**：
- 取消所有 hover 时的 `animate-pulse`（除运行中任务状态点）
- 页面加载使用渐入而非骨架屏闪烁
- 消除不必要的 transition-all，只对特定属性做 transition

#### 物の哀れ（Mono no Aware）— 情感共鸣

> インターフェースは感情に応答する

系统应该感知用户的操作意图并给出有温度的回应。

**应用**：
- 批准任务后显示：「✓ 已批准 · 任务继续推进」（而非通用 toast）
- 任务完成后 Room 进度条有满足感的动画
- 空 Room 状态显示「还没有任务 · 开始你的第一个 Mission 吧」

#### 不均斉（Fukinsei）— 不对称张力

> 対称は安心を、非対称は生命を与える

避免过度对称的网格布局，用视觉重量引导注意力流向。

**应用**：
- Review 状态的操作条（ActionBar）在视觉上比 normal 状态更重/更突出
- 主操作按钮（Approve / Complete）视觉重量明显大于次操作（Cancel / Reject）

#### 間（Ma）的延伸 — 上下文感知

> 今、ここにいる人に必要なものだけを

**应用**：
- TaskView 根据 task.status 动态显示操作区域，不显示当前无法执行的操作

### 3.2 Apple HIG 核心原则

#### Clarity（清晰）
- 每个 icon 只传递一个明确含义
- 文字层级：h1 > h2 > body > caption，每级字重/字号有明确差异
- 操作按钮使用动词短语：「批准任务」而非「OK」

#### Deference（退让）
- UI chrome 服务于内容，不与之竞争
- 侧边栏、header 使用半透明背景（`backdrop-blur`），让内容透过去
- 大量使用 `bg-opacity` 而非纯色块分割区域

#### Depth（层次感）
- 三层视觉层次：底层（content）→ 中层（panels）→ 顶层（modals/overlays）
- 每层通过微妙的 border + shadow + background 区分
- 模态框使用 `bg-black/70 backdrop-blur-sm` 强调层深

#### Direct Manipulation（直接操作）
- **核心原则**：在任务出现的地方就能直接操作它
- Review 任务的 Approve/Reject 按钮**直接嵌入** TaskItem 卡片内
- 不需要进入 TaskView 再操作——除非用户想看详情

#### Feedback（即时反馈）
- 每个操作在 100ms 内有视觉响应（`active:scale-[0.98]`）
- 异步操作显示 loading 状态，不阻塞 UI
- 操作完成后 toast 信息具体（「任务「实现登录功能」已批准」）

#### User Control（用户主权）
- 破坏性操作（Cancel Task、Delete Room）需要确认
- 提供撤销机会（Archive 而非直接 Delete）
- 用户可以随时中断 agent（Interrupt 按钮始终可见）

---

## 4. 信息架构重设计

### 4.1 当前 IA 问题图

```
[Home]  ← 显示 Room 列表（与 Rooms 功能重叠）
[Rooms] ← 也显示 Room 列表
         └── Room: Overview/Context/Agents/Missions/Settings
[Chats] ← 独立 Session 列表
[Settings]
```

**问题**：Home 和 Rooms 语义重叠；Room 内 Settings 与全局 Settings 概念混用。

### 4.2 新 IA 方案

```
[∞ Inbox]   ← 新增：全局「需要我处理」视图（P0 修复）
[⊡ Rooms]   ← 合并 Home + Rooms，统一入口
  └── [Room 详情]
        ├── 概览（Tasks 为主）
        ├── 会话（Sessions 列表）
        ├── Missions（Goals）
        └── 配置
[💬 Chats]  ← 保持独立 Session 管理
[⚙ Settings] ← 仅全局设置
```

#### Inbox（待处理中心）——核心新增

专门用于汇聚「需要用户介入」的所有事项：

```
┌─────────────────────────────────────────────┐
│  📥 Inbox                         2 pending │
├─────────────────────────────────────────────┤
│  ● 需要审批  (1)                            │
│  ┌────────────────────────────────────────┐ │
│  │ [Room: 后端重构] 实现 JWT 认证          │ │
│  │ Worker 已完成，等待您的批准             │ │
│  │                    [驳回] [✓ 批准]     │ │
│  └────────────────────────────────────────┘ │
│                                             │
│  ● 需要关注  (1)                            │
│  ┌────────────────────────────────────────┐ │
│  │ [Room: 前端项目] 修复登录 Bug           │ │
│  │ 错误：API 连接超时                      │ │
│  │                         [→ 查看详情]   │ │
│  └────────────────────────────────────────┘ │
└─────────────────────────────────────────────┘
```

**特性**：
- NavRail 上的 Inbox 图标显示未处理数量 badge
- 直接在 Inbox 内完成 Approve/Reject 操作，无需跳转
- 操作后条目消失（动画），无条目时显示「一切就绪 ✓」

### 4.3 Room 内部 IA 简化

**当前**：Overview / Context / Agents / Missions / Settings（5 个 Tab）

**新方案**：

```
Room 视图
├── [任务] Tab（默认，原 Overview）
│   ├── 运行状态控制条（Runtime Control）
│   ├── 任务列表（按状态分组，直接操作）
│   └── 快速创建任务入口
├── [会话] Tab（Sessions，从 Overview 分离）
├── [Missions] Tab（Goals，保持原名）
└── [···] 更多菜单 → Context / Agents / Settings
```

**理由**：Tasks 是 Room 的核心用途，应占据主 Tab；Sessions 是辅助视图；Agents/Context/Settings 是配置类，收入「更多」减少视觉噪音。

---

## 5. 核心 UX 改造：任务确认中心化

### 5.1 设计原则

**原则**：**操作发生在数据所在之处（Direct Manipulation）**

任务审批操作不应要求用户跳转到 TaskView 才能完成。批准/驳回应该**就在任务卡片上**发生。

### 5.2 TaskCard 重设计

#### 当前 TaskItem（问题版）

```tsx
// RoomTasks.tsx — TaskItem
// Review 状态只有一个小 "Approve" 按钮，需要先点进 Review Tab 才能看到
<div class="px-4 py-3">
  <h4>{task.title}</h4>
  {showApprove && <button>Approve</button>}  // 小、不显眼
  {showView && <button>View</button>}
</div>
```

#### 新 TaskCard（解决方案）

Review 状态的任务卡片自动展开行动区：

```
┌─────────────────────────────────────────────────┐
│  🔵 实现 JWT 认证模块                    review  │
│  Worker 已完成初稿，等待审批                     │
│  ──────────────────────────────────────────────  │
│  📎 PR #42 查看 →                               │
│  💬 "完成了 JWT 签发、验证、刷新逻辑..."         │
│                                                  │
│  ┌──────────────────┐  ┌──────────────────────┐ │
│  │  ✕ 驳回并反馈    │  │  ✓ 批准，继续推进    │ │
│  └──────────────────┘  └──────────────────────┘ │
└─────────────────────────────────────────────────┘
```

**特性**：
- Review 状态的 TaskCard 自动展开（无需点击）
- 显示 Worker 的完成摘要（取自最后一条 worker 消息）
- 批准按钮为主操作（primary，右侧），驳回为次操作（ghost，左侧）
- 点击「驳回」展开内联反馈输入框（而非弹窗）
- 点击「查看」才进入 TaskView 看完整对话

#### 驳回的内联反馈流

```
┌─────────────────────────────────────────────────┐
│  🔵 实现 JWT 认证模块                    review  │
│  ──────────────────────────────────────────────  │
│  请说明需要改进的地方：                          │
│  ┌──────────────────────────────────────────┐   │
│  │ 需要增加 refresh token 的过期处理逻辑...  │   │
│  └──────────────────────────────────────────┘   │
│                           [取消]  [发送反馈 →]  │
└─────────────────────────────────────────────────┘
```

**内联反馈** 代替弹窗，减少上下文切换，保持用户在任务列表中的视角。

### 5.3 TaskView 操作区统一

TaskView 内部操作区也需要重新组织，确保**主操作始终可见、位置固定**。

#### 当前问题

```
TaskView Header（当前）：
[← 返回] [任务标题] [状态] [进度条] [⏹中断] [⋮菜单]
                                              ↑
                        「Mark as Complete」「Cancel Task」藏在这里！
```

#### 新 TaskView 操作区

```
TaskView Header（新）：
┌─────────────────────────────────────────────────────┐
│  ← 后端重构                                         │
│  实现 JWT 认证模块  ·  review  ·  PR #42            │
│                          [⏹] [驳回] [✓ 批准任务]   │
├─────────────────────────────────────────────────────┤
│ 进度: ████████░░ 80%  ·  Worker 正在处理...         │
└─────────────────────────────────────────────────────┘
```

**规则**：
- **Review 状态**：显示「驳回」+ 「✓ 批准任务」（primary）
- **in_progress 状态**：显示「标记完成」（secondary）+ 「取消任务」（ghost/danger）
- **completed/cancelled 状态**：只显示「返回」
- **所有操作按钮始终可见**，不藏入下拉菜单
- 「取消任务」始终在视觉上权重最轻（ghost 或最末），防止误点

### 5.4 Inbox 全局操作视图

新增 Inbox 页面作为全局「需要我处理」中心：

```
┌──────────────────────────────────────────────────────┐
│  📥 Inbox                                            │
│  今天有 2 项需要您的处理                             │
├──────────────────────────────────────────────────────┤
│                                                      │
│  待审批  ────────────────────────────────────────    │
│                                                      │
│  ┌──────────────────────────────────────────────┐   │
│  │ Room: 后端重构 API                           │   │
│  │ ■ 实现 JWT 认证模块                  review  │   │
│  │   "完成了 JWT 签发、验证、刷新逻辑，         │   │
│  │    添加了单元测试..."                        │   │
│  │   📎 PR #42  ·  1小时前                     │   │
│  │   ┌─────────────┐  ┌──────────────────────┐ │   │
│  │   │  ✕ 驳回     │  │  ✓ 批准任务          │ │   │
│  │   └─────────────┘  └──────────────────────┘ │   │
│  └──────────────────────────────────────────────┘   │
│                                                      │
│  需要关注  ───────────────────────────────────────   │
│                                                      │
│  ┌──────────────────────────────────────────────┐   │
│  │ Room: 前端项目                               │   │
│  │ ■ 修复登录页 Bug                needs_attn   │   │
│  │   错误：连接 API 超时 (ETIMEDOUT)            │   │
│  │                           [→ 进入任务查看]  │   │
│  └──────────────────────────────────────────────┘   │
│                                                      │
└──────────────────────────────────────────────────────┘
```

### 5.5 NavRail Badge 系统

```
[📥]  ← Inbox 图标，有 badge 时显示数字（红色气泡）
 2    ← 代表 2 项待处理（review + needs_attention 合计）
```

实现逻辑：
- 跨所有 Room 的 `status === 'review'` 任务数 + `status === 'needs_attention'` 任务数
- badge 数字 > 9 显示「9+」
- 所有任务处理完毕后 badge 消失，Inbox 图标恢复正常

---

## 6. 视觉语言系统

### 6.1 品牌标识重设计

**当前**：🤖 emoji

**新方案**：

```
HyperNeo Logo Mark：
  ◈  （菱形内有十字分割，代表「多个 agent 协同」）

  字体 Logo：
  neo·kai  （neo: 新/革新，kai: 開/改）
```

配色：主色 `#7C6FF7`（indigo-violet，区别于当前 blue）

### 6.2 色彩语义重建

| 语义 | 颜色 | Tailwind | 使用场景 |
|------|------|----------|----------|
| 主操作 / 品牌 | 靛紫 | `indigo-500` | 主按钮、active 状态、link |
| 成功 / 完成 | 翡翠绿 | `emerald-500` | 完成状态、批准按钮 |
| 需要审批 | 琥珀 | `amber-500` | review badge、审批操作条 |
| 需要关注 | 珊瑚红 | `rose-500` | needs_attention |
| 进行中 | 天蓝 | `sky-400` | in_progress 状态点 |
| 信息/中性 | 石板灰 | `slate-400` | 辅助文字、pending |

**色彩使用原则（Ma 原则）**：
- 同一屏幕中，**语义色彩最多使用 2 种**
- 大面积背景**只用中性色**（dark-*），彩色仅用于小面积状态指示
- hover 状态使用同色 +/- 1 阶，不引入新颜色

### 6.3 字体层级系统

```
页面标题 (Page Title):   20px / 700 / text-gray-50   → Room 名称
区域标题 (Section):      14px / 600 / text-gray-200  → Tasks、Sessions
列表项标题 (Item Title): 14px / 500 / text-gray-100  → Task 标题
辅助文字 (Caption):      12px / 400 / text-gray-400  → 时间戳、状态
微文字 (Micro):          11px / 400 / text-gray-500  → 数字、标签
```

### 6.4 间距系统（Ma 原则落地）

```
组件内边距:   16px (p-4) — 通用卡片
列表行高:     48px (py-3 + content) — 可点击列表项
区域间距:     24px (space-y-6) — 主要内容区块间
面板内边距:   20px (p-5) — 侧边栏、详情面板
页面边距:     24px (px-6) — 主内容区水平边距
```

### 6.5 阴影与层次系统

```
层级 0 (底层内容):   无阴影，bg-dark-900
层级 1 (卡片):       border + bg-dark-850，shadow-sm
层级 2 (悬浮面板):   border + bg-dark-800，shadow-md + backdrop-blur
层级 3 (模态框):     border + bg-dark-900，shadow-2xl + backdrop-blur-sm
层级 4 (Toast):      border + bg-dark-800，shadow-lg，无 backdrop
```

---

## 7. 组件级重设计

### 7.1 Button 组件扩展

现有 variant 系统（primary/secondary/ghost/danger/warning）基础良好，需要补充：

```typescript
// 新增 variant
'approve'  // emerald + 勾选图标，用于任务批准
'review'   // amber + 时钟图标，用于提交 review
'interrupt' // amber-outline，用于中断 agent

// 新增 size
'xs'  // 紧凑场景，列表内嵌按钮

// 新增 icon position
iconPosition?: 'left' | 'right'  // 默认 left

// 新增 feedback
successFeedback?: string  // 点击后短暂显示成功状态
```

### 7.2 TaskCard 组件（新建）

取代 `TaskItem`，支持状态感知的动态展开：

```typescript
interface TaskCardProps {
  task: TaskSummary;
  allTasks: TaskSummary[];  // 用于计算依赖状态
  variant: 'compact' | 'expanded';  // compact = 普通列表，expanded = review 自动展开
  onApprove?: (taskId: string) => void;
  onReject?: (taskId: string, feedback: string) => void;
  onComplete?: (taskId: string) => void;
  onClick?: (taskId: string) => void;
}
```

**状态映射**：
```
pending      → compact  + 无操作按钮
in_progress  → compact  + [标记完成]（ghost，低权重）
review       → expanded + [驳回] + [✓ 批准]（显眼）
completed    → compact  + 置灰样式
needs_attention → compact + 错误摘要展开 + [查看]
cancelled    → compact  + 置灰删除线
```

### 7.3 ActionBar 组件（新建）

统一处理「需要用户决策」的操作条，替代当前的 `HeaderReviewBar`：

```typescript
interface ActionBarProps {
  type: 'review' | 'needs_attention' | 'confirm';
  title: string;
  description?: string;
  primaryAction: ActionButtonConfig;
  secondaryAction?: ActionButtonConfig;
  meta?: React.ReactNode;  // PR link、时间戳等
}
```

ActionBar 使用规则：
- 出现在**卡片内部底部**（inline），而非页面顶部的全局条
- 唯一例外：TaskView 中的 ActionBar 出现在 header 区域（因为整个 TaskView 就是一个任务的专属页面）

### 7.4 InlineRejectForm 组件（新建）

取代 `RejectModal`，在卡片内展开的内联反馈表单：

```typescript
interface InlineRejectFormProps {
  isOpen: boolean;
  onCancel: () => void;
  onSubmit: (feedback: string) => Promise<void>;
  placeholder?: string;
}
```

**交互流程**：
1. 点击「驳回」→ 卡片高度展开（CSS transition: height auto with clip-path）
2. 显示 textarea + 「取消」+「发送反馈」按钮
3. 发送后卡片收起，显示「已发送反馈」toast

### 7.5 InboxBadge 组件（新建）

NavRail 上的 Inbox 角标：

```typescript
interface InboxBadgeProps {
  count: number;  // 总计待处理数
  animate?: boolean;  // 新增时闪烁
}
// count === 0 时不渲染，不占位
// count > 9 时显示 "9+"
```

### 7.6 NavRail 升级

```
当前结构:        新结构:
[🤖]             [◈]              ← 新 Logo Mark
[Home]           [📥 Inbox] (2)   ← 新增，带 badge
[Rooms]          [⊡ Rooms]        ← 合并 Home+Rooms
[Chats]          [💬 Chats]
[Settings]       ────────────     ← 分隔线
                 [⚙ Settings]     ← 底部
```

### 7.7 ContextPanel 简化

**当前**：ContextPanel 内容根据 navSection 完全切换（Sessions 列表 / Room 列表 / 设置菜单）

**新方案**：
- **Inbox** section → ContextPanel 隐藏（Inbox 内容就是主内容区）
- **Rooms** section → ContextPanel 显示 Room 列表 / Room 内导航
- **Chats** section → ContextPanel 显示 Session 列表
- **Settings** section → ContextPanel 显示设置分类

减少 ContextPanel 在 Inbox/Home 时的存在，用「Ma」原则，让主内容区更宽敞。

---

## 8. 交互动效规范

### 8.1 动效哲学（静寂原则）

**规则**：
- 状态变化 < 150ms：直接切换，无动画
- 状态变化 150ms - 500ms：使用 `transition-opacity duration-150`
- 面板展开/收起：`transition: height 250ms cubic-bezier(0.4, 0, 0.2, 1)`
- 页面级导航：`opacity 0→1, 200ms ease-out`（进入），无退出动画
- 重要通知（新 review 任务）：badge 出现时 `scale 0.5→1, 150ms spring`

**禁止**：
- 禁止任何 > 400ms 的 UI 动画
- 禁止在列表排序时使用 flip 动画（性能风险）
- 禁止在 hover 上使用非 opacity/color 的动画
- 禁止 `animate-bounce`（用 `animate-pulse` 替代状态指示）

### 8.2 TaskCard 状态切换动效

```
review → completed（批准后）:
  1. 按钮变为 loading 状态（150ms）
  2. 按钮显示 "✓ 已批准"（300ms）
  3. 卡片 border 变为 emerald（100ms）
  4. 卡片 opacity 降至 0.4（500ms）
  5. 卡片移入 Done tab（UI 刷新）

review → in_progress（驳回后）:
  1. 内联表单折叠（200ms）
  2. toast: "反馈已发送，Worker 将重新处理"
  3. 卡片状态更新为 in_progress
```

### 8.3 Inbox Badge 动效

```
新增待处理项时:
  badge 数字: 旧数字向上飞出 + 新数字从下进入（slot-machine 效果，100ms）

所有项处理完毕时:
  badge 缩小至 0 并消失（scale + opacity，200ms）
  Inbox 图标短暂变绿（200ms），然后恢复
```

---

## 9. 响应式与移动端

### 9.1 断点策略

```
Mobile:   < 768px  → 底部导航栏 + 全屏面板
Tablet:   768-1024px → NavRail + 折叠 ContextPanel
Desktop:  > 1024px  → 三列布局完整显示
Wide:     > 1440px  → ContextPanel 加宽至 320px
```

### 9.2 移动端导航重设计

**当前**：移动端把整个 ContextPanel（含导航）从左侧滑出，体验不流畅。

**新方案**：Bottom Tab Bar（iOS 风格）

```
┌─────────────────────────────────┐
│                                 │
│          主内容区               │
│                                 │
├─────────────────────────────────┤
│  [📥]  [⊡]  [💬]  [⚙]        │
│  2           Rooms  Chats  ...  │
└─────────────────────────────────┘
```

- Bottom Bar 背景使用 `backdrop-blur + bg-dark-900/90`（iOS 风格磨砂）
- Safe area inset 支持（`pb-safe`）
- 点击 Rooms 后，从右侧滑入 Room 列表面板

### 9.3 TaskCard 移动适配

- 移动端 TaskCard 的 Approve/Reject 按钮使用全宽（`w-full`）
- 内联反馈表单在移动端从底部 sheet 弹出（而非内联展开）

---

## 10. 实施路线图

### Phase 1 — P0 修复（1-2 周）

**目标**：解决最影响用户的任务确认交互问题

| # | 任务 | 影响 | 工作量 |
|---|------|------|--------|
| 1.1 | 将 TaskView 的 `CompleteTask`/`CancelTask` 从 3-dot 菜单移至 header 明显位置 | P0 | S |
| 1.2 | 统一 Review 状态的 Approve 入口（移除 RoomDashboard 内的 ConfirmModal approve，统一用 HeaderReviewBar 样式的 ActionBar） | P0 | M |
| 1.3 | 在 RoomDashboard Review Tab 的 TaskItem 展示 Worker 摘要 + 增大操作按钮 | P0 | S |
| 1.4 | NavRail 新增 Inbox 入口，带全局待处理 badge | P0 | M |
| 1.5 | 实现基础 Inbox 页面（列出所有 review + needs_attention 任务） | P0 | M |

### Phase 2 — 视觉系统统一（2-3 周）

**目标**：建立一致的视觉语言

| # | 任务 | 影响 | 工作量 |
|---|------|------|--------|
| 2.1 | 设计并实现新 Logo Mark（◈ 字符 + 统一品牌色 indigo-500） | P1 | S |
| 2.2 | 重写 `design-tokens.ts`，建立新色彩语义系统 | P1 | M |
| 2.3 | 统一所有 confirm 对话框为 `ActionBar` 组件（inline）和 `Modal` 组件（destructive only） | P1 | L |
| 2.4 | Button 组件扩展（approve/review variant，xs size，successFeedback） | P1 | S |
| 2.5 | 升级 TaskItem → TaskCard（状态感知的动态展开） | P1 | L |

### Phase 3 — IA 重构（3-4 周）

**目标**：简化导航层级，提升信息可发现性

| # | 任务 | 影响 | 工作量 |
|---|------|------|--------|
| 3.1 | 合并 NavRail 的 Home + Rooms → 单一 Rooms 入口 | P1 | M |
| 3.2 | Room 内 Tab 重构：任务/会话/Missions/··· | P1 | M |
| 3.3 | Inbox 页面完善（跨 Room 操作、分组、过滤） | P0 | L |
| 3.4 | 移动端 Bottom Tab Bar 实现 | P2 | L |
| 3.5 | ContextPanel 在 Inbox 下隐藏，给主内容区更多空间 | P2 | S |

### Phase 4 — 动效与精细化（持续）

| # | 任务 | 工作量 |
|---|------|--------|
| 4.1 | TaskCard 批准/驳回动效 | M |
| 4.2 | Inbox Badge 数字动效 | S |
| 4.3 | 面板展开/收起动效统一 | M |
| 4.4 | Toast 升级（具体化、操作级别差异化） | S |

---

## 附录 A：关键交互流程对比

### 当前流程：批准一个 Review 任务

```
进入 Lobby
  → 点击 NavRail [Rooms]
    → 点击 ContextPanel 中的具体 Room
      → Room Dashboard 加载
        → 找到 Tasks 区域
          → 点击 "Review" tab（可能默认不是 Review tab）
            → 看到待审批任务
              → 点击 "Approve" 按钮
                → 弹出 ConfirmModal
                  → 点击确认

步骤：8 步 | 深度：4 层导航 | 操作：1 次弹窗确认
```

### 新流程：批准一个 Review 任务

```
看到 NavRail [📥] badge 显示 "1"
  → 点击 [📥 Inbox]
    → 看到待审批任务 + 摘要
      → 点击 [✓ 批准任务]
        → 完成（inline 反馈）

步骤：4 步 | 深度：1 层 | 操作：0 弹窗
```

### 当前流程：手动完成一个任务

```
进入 Room
  → 进入 Overview Tab
    → 找到 in_progress 任务
      → 点击任务（进入 TaskView）
        → 找到右上角三点菜单（⋮）
          → 点击 "Mark as Complete"
            → 弹出 CompleteTaskDialog
              → 填写摘要（可选）
                → 点击确认

步骤：9 步 | 深度：5 层 | 明显性：低（藏在三点菜单）
```

### 新流程：手动完成一个任务

```
进入 Room [任务] Tab
  → 看到 in_progress 任务
    → 点击任务卡片上的 [标记完成]（直接可见）
      → 内联确认（可选摘要）
        → 完成

步骤：5 步 | 深度：2 层 | 明显性：高（始终可见）
```

---

## 附录 B：设计 Token 规范

### 新 design-tokens.ts 结构

```typescript
export const colors = {
  brand: {
    primary: 'indigo-500',    // 主品牌色
    primaryHover: 'indigo-600',
    soft: 'indigo-900/20',    // 浅色背景
  },
  semantic: {
    approve: 'emerald-500',
    approveHover: 'emerald-600',
    approveSoft: 'emerald-900/20',

    review: 'amber-500',
    reviewSoft: 'amber-900/20',

    attention: 'rose-500',
    attentionSoft: 'rose-900/20',

    active: 'sky-400',
    activeSoft: 'sky-900/20',

    neutral: 'slate-400',
  },
  surface: {
    base: 'dark-950',      // 最底层背景
    primary: 'dark-900',   // 主内容区
    secondary: 'dark-850', // 侧边栏、面板
    elevated: 'dark-800',  // 卡片
    overlay: 'dark-700',   // 选中态、hover
    border: 'dark-700',    // 通用边框
    borderSubtle: 'dark-800', // 细微分割线
  },
} as const;
```

---

*文档版本 1.0.0 — 基于代码库深度分析（2026-03-19）*
*设计哲学：日本美学七原則 × Apple Human Interface Guidelines*
*优先级：P0 任务确认中心化 → P1 视觉系统统一 → P1 IA 重构 → P2 动效精细化*
