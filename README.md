# dsh-model-toggle — 模型级开关（隐藏 / 显示）

设置页 → 模型，页面底部多出一块「**模型开关**」面板：每个自定义提供商的每个模型一行，右侧一个「隐藏」按钮；隐藏后该模型立即从**对话底部的模型选择器**消失，同一行变成「显示」按钮，随时恢复。

## 使用

1. **刷新网页**（客户端模块只在页面加载时挂载）。
2. 打开 设置 → 模型，滚到底部「模型开关」面板。
3. 点某行的「隐藏」→ 该模型从对话选择器消失；点「显示」→ 恢复原位。

注意：隐藏当前会话正在用的模型前，先把会话切到别的模型。内置 DeepSeek 系提供商没有配置面，不归本插件管（面板里也不会出现）。

## 机制（读给想知道原理的人）

- 对话选择器显示的就是 `llm-pi-ai` 配置里每个提供商的**显式 models 数组**；隐藏 = 把该模型条目从数组摘除，**完整条目原样存进 profile 目录的 `dsh-model-toggle.archive.json`**，显示 = 按原条目合并回去。
- 存档是插件自己的 JSON 文件（版本号 `version: 1`，结构 `{ hidden: { [route]: [modelEntry…] } }`），**不写 DSH 配置系统**——DSH 0.2 的配置校验（volatile 键、ACTIVE 状态过滤、replace 语义）对自写分区不友好，文件存档绕开全部三个坑。
- 归档文件损坏时插件**拒绝一切隐藏操作**（fail-closed），配置一个字节都不会动；`list-states` 会带出 `archiveError`。
- **禁用/卸载本插件时自动把所有已隐藏模型合并回原提供商**（通过 unload 钩子）；已从配置里消失的提供商（例如被「模型 Pro」禁用）保留存档，等提供商恢复后可再显示。
- 与 dsh-model-pro（模型 Pro）共存：两者写的是同一个 providers 表。模型 Pro 的批量编辑是「整体替换」式，会把已隐藏的模型带回来；发现列表对不上时以本插件面板的「显示」状态为准重新隐藏即可。

## 边界

- 只管理 `llm-pi-ai` 的**自定义**提供商（profile `cordis.patch.yml` 里 `config.providers` 表内的）。
- 配置里没有的提供商不出现在面板；被模型 Pro 禁用的提供商以「缺失」状态出现（只读展示存档）。
- 面板一次只允许一个操作在途（防并发写乱序）。

## 故障排查

- 面板没出现 → 确认刷新过网页；确认插件管理里 `dsh-model-toggle` 是 enabled 且 active。
- 面板报错 `active Service "modelToggle" is unavailable` → 说明 `apply()` 里没构造服务实例（`new ModelToggleRuntime(ctx)`）。Cordis 的服务注册发生在构造函数里，漏了这行 `ctx.typert.register(MANIFEST)` 照样成功、但网关取不到实例。
- 面板报错 → 错误文案会带原因；「settings service is not available」说明宿主状态异常，重载插件或重启 DSH。
- 想整份回退 → 插件管理里禁用本插件，所有隐藏模型自动还原；`dsh-model-toggle.archive.json` 还原成功后会被清空。

## 开发自测

`D:\DevCache\temp\mt-test\` 四套（合计 90 项，全部零依赖 stub 假宿主）：

| 脚本 | 项数 | 覆盖 |
|---|---|---|
| `test.mjs` | 52 | host 行为契约（raw/descriptor 两臂）+ 服务注册守卫 |
| `id-check.mjs` | 8 | client.js 的 loader id 必须逐字等于包名 |
| `render-check.mjs` | 16 | FooterPanel 渲染与按钮回调 |
| `wire-check.mjs` | 14 | 与 dsh-model-pro 逐字对照的 wire 契约 |

`test-nofix.mjs` 是变异测试：把 `host.js` 复制成 `host-nofix.js` 并注释掉 `new ModelToggleRuntime(ctx);`，应当跑出 5 条 FAIL——守卫失效时先跑它确认测试本身还有效。

改完 `host.js` / `client.js` 后必须把文件复制到 `mt-test\` 再跑，那套夹具用的是副本。
