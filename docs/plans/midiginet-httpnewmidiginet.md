# MiDiGi.NET 网站全面测试 (https://new.midigi.net/zh)

## Goal

对 MiDiGi.NET 翻新苹果产品电商平台（https://new.midigi.net/zh）进行系统性测试，覆盖功能测试、UI/UX 测试、性能测试、网络请求测试和表单验证测试。所有测试使用 Chrome DevTools MCP 工具（`mcp__chrome-devtools__*`）进行浏览器自动化操作，无需修改 HyperNeo 代码库。

## Approach

每个任务聚焦于独立的测试区域，使用 Chrome DevTools MCP 工具导航页面、检查 DOM、捕获控制台错误、监控网络请求。所有测试结果记录在任务执行日志中，并对照成功标准进行评估。

## Success Criteria

- 所有核心功能页面无 JS 错误
- Lighthouse 性能分数 >= 70
- Lighthouse 可访问性分数 >= 80
- 所有导航链接可正常跳转
- 购物流程关键节点（商品展示 -> 详情 -> 购物车）完整可用
- 出售报价级联选择逻辑正确

---

## Task 1: 首页功能测试

**Type:** general

**Description:**
测试首页（https://new.midigi.net/zh）的核心功能模块，包括导航菜单、Hero 区域按钮跳转、热门产品展示、价格对比模块、FAQ 折叠和 Cookie 弹窗。

**Subtasks:**
1. 使用 `mcp__chrome-devtools__navigate_page` 打开 https://new.midigi.net/zh，等待页面完全加载。
2. 使用 `mcp__chrome-devtools__list_console_messages` 检查页面是否有 JS 错误（收集所有 console.error 输出）。
3. 检查顶部导航菜单：验证购买（Shop）、出售（Sell）、维修（Repair）、帮助（Help）等主要链接可见且可点击，使用 `mcp__chrome-devtools__evaluate_script` 查询链接 href 属性。
4. 测试 Hero 区域的 CTA 按钮：点击主要 CTA 按钮，验证跳转目标 URL 正确；点击返回后继续测试。
5. 检查热门产品展示区域：验证至少有 4 个产品卡片可见，每个卡片包含图片、名称和价格。
6. 测试价格对比模块：使用下拉选择器切换不同型号（iPhone 15 Pro / MacBook Air M2 / iPad Air / iPhone 14），验证价格数据随之更新。
7. 测试 FAQ 折叠功能：点击 FAQ 问题项，验证答案展开/折叠行为正常。
8. 检查 Cookie 弹窗：验证弹窗出现（或记录弹窗已被接受的情况），测试同意/拒绝按钮功能。
9. 记录所有测试结果，标注通过/失败状态及截图证据（使用 `mcp__chrome-devtools__take_screenshot`）。

**Acceptance Criteria:**
- 首页无 JS 错误
- 导航菜单所有链接均可见且有效 href
- Hero CTA 按钮跳转到正确页面
- 热门产品区域展示至少 4 个产品
- 价格对比下拉切换后价格数据更新
- FAQ 折叠/展开功能正常
- Cookie 弹窗按钮可交互

**Dependencies:** None

---

## Task 2: 商店页面与产品详情功能测试

**Type:** general

**Description:**
测试商店页面（https://new.midigi.net/zh/shop）的分类筛选、产品列表加载、产品详情页以及加入购物车流程。

**Subtasks:**
1. 使用 `mcp__chrome-devtools__navigate_page` 打开 https://new.midigi.net/zh/shop，等待产品列表加载完成。
2. 使用 `mcp__chrome-devtools__list_console_messages` 检查页面 JS 错误。
3. 测试分类筛选功能：
   - 依次点击 iPhone、iPad、Mac、配件（Accessories）分类筛选器
   - 每次筛选后验证产品列表已更新，使用 `mcp__chrome-devtools__evaluate_script` 计算产品卡片数量
   - 验证筛选后显示的产品与所选分类匹配（通过产品名称关键词检查）
4. 验证产品列表加载：确认每个产品卡片包含图片、名称、价格、型号信息。
5. 点击第一个产品卡片进入产品详情页：
   - 验证详情页 URL 格式正确（包含产品 ID 或 slug）
   - 检查详情页包含：产品名称、价格、规格参数、产品图片、加入购物车按钮
   - 使用 `mcp__chrome-devtools__take_screenshot` 截图记录
6. 测试加入购物车功能：点击「加入购物车」按钮，验证购物车图标数量增加或弹出确认提示。
7. 返回商店页，验证浏览器后退功能正常。
8. 记录所有测试结果，标注通过/失败及问题描述。

**Acceptance Criteria:**
- 商店页面无 JS 错误
- 分类筛选正确过滤产品列表
- 产品详情页包含所有必要信息
- 加入购物车操作有视觉反馈
- 产品图片正常加载（无破图）

**Dependencies:** None

---

## Task 3: 购物车功能测试

**Type:** general

**Description:**
测试购物车页面（https://new.midigi.net/zh/carrito）的商品增减、删除和价格计算功能。

**Subtasks:**
1. 先通过商店页面将至少一个产品加入购物车（参考 Task 2 步骤 6）。
2. 使用 `mcp__chrome-devtools__navigate_page` 打开 https://new.midigi.net/zh/carrito。
3. 使用 `mcp__chrome-devtools__list_console_messages` 检查页面 JS 错误。
4. 验证购物车页面基本布局：商品列表、数量控制、总价显示、结账按钮。
5. 测试商品数量增加：点击「+」按钮，验证数量增加且小计价格同步更新。
6. 测试商品数量减少：点击「-」按钮，验证数量减少且小计价格同步更新；验证数量不能低于 1 或触发删除确认。
7. 测试商品删除：点击删除按钮，验证该商品从购物车移除，总价重新计算。
8. 如购物车为空，验证显示「购物车为空」提示信息和返回商店的链接。
9. 验证总价计算正确性：使用 `mcp__chrome-devtools__evaluate_script` 获取各商品单价和数量，手动验算总价。
10. 使用 `mcp__chrome-devtools__take_screenshot` 截图记录购物车页面状态。
11. 记录所有测试结果。

**Acceptance Criteria:**
- 购物车页面无 JS 错误
- 商品数量增减功能正常
- 删除功能正常工作
- 价格计算结果正确
- 空购物车状态有友好提示

**Dependencies:** Task 2

---

## Task 4: 用户系统与出售报价页测试

**Type:** general

**Description:**
测试登录页面（https://new.midigi.net/zh/login）的表单验证，以及出售报价页（https://new.midigi.net/zh/compramos）的品牌/类别/型号级联选择逻辑。

**Subtasks:**

### 登录页面测试
1. 使用 `mcp__chrome-devtools__navigate_page` 打开 https://new.midigi.net/zh/login。
2. 使用 `mcp__chrome-devtools__list_console_messages` 检查 JS 错误。
3. 测试空表单提交：不填写任何字段直接点击登录按钮，验证出现必填字段错误提示。
4. 测试无效邮箱格式：输入 `notanemail`，验证出现邮箱格式错误提示。
5. 测试无效密码（如果有密码字段）：输入少于最小长度的密码，验证提示信息。
6. 验证错误提示文案清晰可读。
7. 使用 `mcp__chrome-devtools__take_screenshot` 截图记录错误状态。

### 出售报价页测试
8. 使用 `mcp__chrome-devtools__navigate_page` 打开 https://new.midigi.net/zh/compramos。
9. 使用 `mcp__chrome-devtools__list_console_messages` 检查 JS 错误。
10. 验证级联选择初始状态：品牌选择器可用，类别和型号选择器初始为禁用状态。
11. 选择品牌（如 Apple），验证类别选择器变为可用并加载对应选项。
12. 选择类别（如 iPhone），验证型号选择器变为可用并加载对应选项。
13. 选择具体型号，验证「获取报价」按钮变为可点击状态。
14. 测试不完整选择（如仅选品牌不选类别），验证报价按钮保持禁用。
15. 点击报价按钮，验证页面跳转或显示报价信息。
16. 使用 `mcp__chrome-devtools__take_screenshot` 记录级联选择完整流程。

**Acceptance Criteria:**
- 登录页面表单验证逻辑完整（空字段、格式验证均有提示）
- 出售报价级联选择逻辑正确（按顺序启用）
- 不完整选择时报价按钮保持禁用
- 完整选择后报价流程可触发
- 两个页面均无 JS 错误

**Dependencies:** None

---

## Task 5: 维修服务、订单追踪与帮助页测试

**Type:** general

**Description:**
测试维修服务页（https://new.midigi.net/zh/restauracion）、订单追踪页（https://new.midigi.net/zh/cuenta）和帮助页（https://new.midigi.net/zh/help）的内容完整性和可访问性。

**Subtasks:**

### 维修服务页
1. 使用 `mcp__chrome-devtools__navigate_page` 打开 https://new.midigi.net/zh/restauracion。
2. 使用 `mcp__chrome-devtools__list_console_messages` 检查 JS 错误。
3. 验证页面包含：服务说明文字、设备类型列表、维修项目、预约/联系入口按钮。
4. 点击预约入口，验证跳转目标或弹出预约表单。
5. 使用 `mcp__chrome-devtools__take_screenshot` 截图记录。

### 订单追踪页
6. 使用 `mcp__chrome-devtools__navigate_page` 打开 https://new.midigi.net/zh/cuenta。
7. 使用 `mcp__chrome-devtools__list_console_messages` 检查 JS 错误。
8. 验证页面可访问（HTTP 状态码 200，页面渲染正常）。
9. 若需要登录，验证重定向到登录页逻辑正确；记录重定向 URL。
10. 使用 `mcp__chrome-devtools__take_screenshot` 截图记录页面状态。

### 帮助页
11. 使用 `mcp__chrome-devtools__navigate_page` 打开 https://new.midigi.net/zh/help。
12. 使用 `mcp__chrome-devtools__list_console_messages` 检查 JS 错误。
13. 验证页面包含常见问题或帮助主题列表。
14. 验证帮助内容链接可点击，点击后加载对应内容或跳转到详情页。
15. 使用 `mcp__chrome-devtools__take_screenshot` 截图记录。

**Acceptance Criteria:**
- 维修服务页包含服务说明和预约入口
- 订单追踪页可访问（200 或正确重定向到登录）
- 帮助页包含有效的帮助内容和可点击链接
- 三个页面均无 JS 错误

**Dependencies:** None

---

## Task 6: 搜索功能测试

**Type:** general

**Description:**
测试网站搜索功能，包括搜索框输入 iPhone/iPad/Mac 关键词以及搜索结果展示与跳转。

**Subtasks:**
1. 使用 `mcp__chrome-devtools__navigate_page` 打开 https://new.midigi.net/zh。
2. 使用 `mcp__chrome-devtools__evaluate_script` 查找页面中的搜索框元素（通过 `input[type="search"]` 或搜索图标）。
3. 点击搜索框或搜索图标，确认搜索界面被激活。
4. 搜索「iPhone」：
   - 在搜索框中输入「iPhone」
   - 等待搜索结果出现（自动完成列表或跳转搜索结果页）
   - 验证结果中包含 iPhone 相关产品，使用 `mcp__chrome-devtools__take_screenshot` 截图
5. 清空搜索框，搜索「iPad」：验证结果中包含 iPad 相关产品。
6. 清空搜索框，搜索「Mac」：验证结果中包含 Mac 相关产品。
7. 测试搜索结果点击跳转：点击搜索结果中的某个产品，验证跳转到对应产品详情页。
8. 测试空搜索提交：提交空搜索或仅空格，验证页面不崩溃，提示用户输入关键词。
9. 记录搜索功能的完整性（是否存在搜索框、结果是否相关、跳转是否正确）。

**Acceptance Criteria:**
- 搜索框可被找到并激活
- iPhone/iPad/Mac 搜索均返回相关结果
- 点击搜索结果可正确跳转到产品页
- 空搜索不导致 JS 错误或页面崩溃

**Dependencies:** None

---

## Task 7: UI/UX 交互测试

**Type:** general

**Description:**
测试深色模式切换、语言切换、产品评价轮播、运营流程步骤标签切换（购买/出售/维修）以及响应式布局。

**Subtasks:**

### 深色模式切换
1. 使用 `mcp__chrome-devtools__navigate_page` 打开 https://new.midigi.net/zh。
2. 查找深色模式切换按钮（通常在导航栏）；使用 `mcp__chrome-devtools__evaluate_script` 定位。
3. 点击深色模式切换，使用 `mcp__chrome-devtools__evaluate_script` 检查 `document.documentElement` 的 `class` 或 `data-theme` 属性是否变化。
4. 截图记录深色模式下的页面外观。
5. 再次切换回浅色模式，验证恢复正常。

### 语言切换
6. 查找语言切换器（通常在导航栏）；点击语言切换器展开选项。
7. 切换到英语（EN）或其他语言，验证页面 URL 变化（如 `/en/`）且页面内容语言变更。
8. 截图记录。
9. 切换回中文（ZH），验证恢复。

### 产品评价轮播
10. 滚动到评价轮播区域（通常在首页底部区域）。
11. 点击轮播的「下一页」箭头，验证评价内容切换。
12. 点击「上一页」箭头，验证反向切换。
13. 如有分页指示点，点击指示点验证直接跳转到对应页。

### 运营流程步骤标签
14. 在首页找到「购买/出售/维修」流程说明区域（通常有标签切换 tab）。
15. 依次点击「购买」「出售」「维修」标签，验证每次切换后内容区域更新，显示对应流程步骤。
16. 截图记录三种状态。

### 响应式布局测试
17. 使用 `mcp__chrome-devtools__emulate` 模拟 iPhone 视口（375×812，deviceScaleFactor 2），或使用 `mcp__chrome-devtools__resize_page` 将页面宽度设置为 375px；不要使用 `window.resizeTo()`（在 Chromium 中不可靠）。
18. 验证导航菜单在移动端折叠为汉堡菜单。
19. 验证产品卡片在移动端单列或两列排列。
20. 点击汉堡菜单，验证展开后可访问所有导航链接。
21. 截图记录移动端布局。

**Acceptance Criteria:**
- 深色模式切换有视觉变化且属性正确更新
- 语言切换后 URL 和内容均变更
- 评价轮播翻页功能正常
- 运营流程三个标签内容各不相同
- 移动端导航菜单正确折叠/展开
- 375px 宽度下无水平溢出滚动条

**Dependencies:** None

---

## Task 8: 性能测试（Lighthouse 审计）

**Type:** general

**Description:**
使用 Chrome DevTools Lighthouse 对首页、商店页和产品详情页进行综合性能审计，检查性能、可访问性、SEO、最佳实践分数。

**Subtasks:**

### 首页 Lighthouse 审计
1. 使用 `mcp__chrome-devtools__navigate_page` 打开 https://new.midigi.net/zh，等待完全加载。
2. 使用 `mcp__chrome-devtools__lighthouse_audit` 对首页执行 Lighthouse 审计，获取完整评分报告。
3. 从报告中记录以下四项数值分数（0–100）：
   - **性能（Performance）**
   - **可访问性（Accessibility）**
   - **最佳实践（Best Practices）**
   - **SEO**
4. 记录关键 Web Vitals 指标：FCP、LCP、TBT、CLS。

### 商店页 Lighthouse 审计
5. 使用 `mcp__chrome-devtools__navigate_page` 打开 https://new.midigi.net/zh/shop。
6. 重复步骤 2-4，记录商店页 Lighthouse 评分和 Web Vitals。

### 产品详情页 Lighthouse 审计
7. 进入任意产品详情页（通过商店页点击产品或直接构造 URL）。
8. 重复步骤 2-4，记录产品详情页 Lighthouse 评分和 Web Vitals。

### 汇总报告
9. 对比三个页面的 Lighthouse 数据，明确记录是否满足目标成功标准：
   - 性能分数 >= 70（三个页面均须达到）
   - 可访问性分数 >= 80（三个页面均须达到）
10. 列出未达标的页面及具体分数，提供改进建议。

**Acceptance Criteria:**
- 三个页面的 `mcp__chrome-devtools__lighthouse_audit` 报告均已成功获取
- 每个页面的性能分数（Performance score）已记录，并标注是否 >= 70
- 每个页面的可访问性分数（Accessibility score）已记录，并标注是否 >= 80
- 未达标页面的问题点已列举并附改进建议

**Dependencies:** None

---

## Task 9: 网络请求与图片 CDN 测试

**Type:** general

**Description:**
监控页面加载期间的关键 API 请求状态码，检查图片 CDN 加载成功率，识别 4xx/5xx 错误。

**Subtasks:**
1. 使用 `mcp__chrome-devtools__navigate_page` 打开 https://new.midigi.net/zh，等待完全加载。
2. 使用 `mcp__chrome-devtools__list_network_requests` 列出首页加载期间的所有网络请求。
3. 遍历请求列表，筛选出以下类别并记录：
   - **API 请求**：URL 包含 `/api/` 的条目，使用 `mcp__chrome-devtools__get_network_request` 获取每条请求的详细状态码；标记所有 4xx/5xx 错误。
   - **图片资源**：URL 以 `.jpg`、`.png`、`.webp`、`.avif` 结尾的条目，记录状态码和耗时。
4. 对商店页（https://new.midigi.net/zh/shop）重复步骤 1-3。
5. 特别检查图片 CDN：
   - 统计图片请求总数和返回 2xx 的成功数，计算成功率
   - 识别加载耗时超过 3 秒的图片
   - 对状态码 4xx 的图片 URL 单独列出
6. 使用 `mcp__chrome-devtools__evaluate_script` 补充检查页面内破损图片（DOM 层面）：
   ```js
   Array.from(document.images).filter(img => !img.complete || img.naturalWidth === 0).map(img => img.src)
   ```
7. 记录所有失败的网络请求（含状态码）和破损图片 URL，汇总成功率数据。

**Acceptance Criteria:**
- 首页和商店页的网络请求清单已通过 `mcp__chrome-devtools__list_network_requests` 收集
- 每条 API 请求的实际 HTTP 状态码已通过 `mcp__chrome-devtools__get_network_request` 确认（无 4xx/5xx）
- 图片 CDN 加载成功率 >= 95%（基于实际 HTTP 状态码统计）
- 所有破损图片（DOM naturalWidth === 0）已列出

**Dependencies:** None

---

## Task 10: 表单验证测试

**Type:** general

**Description:**
测试邮件订阅表单（首页）的空提交、无效邮箱、有效邮箱场景，以及登录表单（https://new.midigi.net/zh/login）的完整验证逻辑。

**Subtasks:**

### 邮件订阅表单（首页）
1. 使用 `mcp__chrome-devtools__navigate_page` 打开 https://new.midigi.net/zh，滚动到页脚或邮件订阅区域。
2. 使用 `mcp__chrome-devtools__evaluate_script` 定位订阅表单元素：`document.querySelector('form[action*="subscribe"], form input[type="email"]')`。
3. 测试空提交：清空邮箱输入框，点击订阅按钮，验证出现「请输入邮箱」或类似错误提示。
4. 测试无效邮箱格式：输入 `test@invalid`（无顶级域名），点击提交，验证格式验证错误提示。
5. 测试有效邮箱：输入 `test_automation@example.com`，点击提交，验证提交成功提示（或提示「邮件已存在」）；记录实际响应。
6. 截图记录各验证状态。

### 登录表单（详细验证）
7. 使用 `mcp__chrome-devtools__navigate_page` 打开 https://new.midigi.net/zh/login。
8. 测试空邮箱字段提交，记录错误提示文案。
9. 测试空密码字段提交（邮箱已填写），记录错误提示。
10. 测试格式错误邮箱（`plainaddress`、`@missingdomain.com`、`email@`），逐一验证提示。
11. 测试有效格式邮箱 + 错误密码，验证服务端错误提示（如「邮箱或密码错误」）。
12. 验证密码输入框默认为 `type="password"`（不明文显示）。
13. 如有「显示密码」切换按钮，测试其切换 `type` 属性功能。
14. 记录所有验证场景及实际结果。

**Acceptance Criteria:**
- 订阅表单空提交有错误提示
- 订阅表单无效邮箱格式有错误提示
- 有效邮箱提交有成功或已注册提示
- 登录表单空字段有错误提示
- 登录表单格式无效邮箱有错误提示
- 密码字段默认不明文显示

**Dependencies:** None

---

## Key Context

### 测试工具（正确工具名称速查）

所有测试通过 Chrome DevTools MCP 工具执行。下表为本计划使用到的**完整正确工具名称**（请勿使用未列出的简写名称）：

| 工具名称 | 用途 |
|---|---|
| `mcp__chrome-devtools__navigate_page` | 页面导航（打开 URL） |
| `mcp__chrome-devtools__evaluate_script` | 执行 JavaScript 表达式 |
| `mcp__chrome-devtools__take_screenshot` | 截图记录当前页面状态 |
| `mcp__chrome-devtools__list_console_messages` | 获取控制台输出（包含 JS 错误） |
| `mcp__chrome-devtools__lighthouse_audit` | 运行 Lighthouse 审计，返回性能/可访问性/SEO/最佳实践评分 |
| `mcp__chrome-devtools__list_network_requests` | 列出页面所有网络请求 |
| `mcp__chrome-devtools__get_network_request` | 获取单条请求详情（含实际 HTTP 状态码） |
| `mcp__chrome-devtools__resize_page` | 调整页面视口尺寸（响应式布局测试） |
| `mcp__chrome-devtools__emulate` | 模拟移动设备视口（推荐替代 window.resizeTo） |
| `mcp__chrome-devtools__click` | 点击页面元素 |
| `mcp__chrome-devtools__fill` | 填写表单输入字段 |
| `mcp__chrome-devtools__type_text` | 在当前焦点元素中输入文本 |

### 网站信息

- 目标 URL：https://new.midigi.net/zh
- 类型：翻新苹果设备电商平台（购买/出售/维修）
- 支付方式：Visa、Mastercard、PayPal、Apple Pay、Klarna
- 语言支持：中文（zh）、多语言

### 测试执行顺序建议

建议按照以下顺序执行以提高效率：
1. Task 1（首页功能）- 建立基础了解
2. Task 2（商店页）+ Task 6（搜索）- 核心购物功能
3. Task 3（购物车）- 依赖 Task 2
4. Task 4（登录/出售报价）+ Task 5（其他页面）- 独立测试
5. Task 7（UI/UX）- 交互测试
6. Task 8（性能）+ Task 9（网络请求）- 技术测试
7. Task 10（表单验证）- 补充验证

### 注意事项

- 测试中不应实际下单或提供真实支付信息
- 登录测试使用测试账号（如有）或仅测试前端验证逻辑
- 订阅表单测试使用测试邮箱，避免骚扰真实邮件服务
- 所有测试结果应记录截图证据
