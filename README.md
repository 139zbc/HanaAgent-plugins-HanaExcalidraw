# 白板 · Excalidraw for HanaAgent

 把 [Excalidraw](https://excalidraw.com) 搬进 HanaAgent，让你和 Agent 共用同一块画板。

 - 仓库：<https://github.com/139zbc/HanaAgent-plugins-HanaExcalidraw>
 - 宿主项目 HanaAgent：<https://github.com/liliMozi/openhanako>
 - App id `hana-excalidraw` ｜ 当前版本 `1.0.0` ｜ 最低宿主版本 `0.1028.0` ｜ Manifest `manifestVersion: 2`


---


## 这是什么

AI 画图的老问题是画完就断：图在对话框里，改不了、存不住、也传不到你正在写的那份文档里。这个插件的立场是——**画板归你，Agent 只是个手比你快的同桌**。

它在 HanaAgent 里装了一块真正的 Excalidraw 画布，三件事因此成立：

1. **你画的就是文件。** 每块画板是磁盘上一个标准的 `.excalidraw` 文件，可以拷出来用 Excalidraw 本体打开，也可以把别的 `.excalidraw` 拷进来。
2. **两边同时画不打架。** 你落笔时 Agent 正在写的图不会被清空，Agent 改图时你的手绘也保住——后端按元素 `id` 合并，同 id 的元素保留笔迹随机种子、图层顺序和箭头绑定，所以 Agent 动过的框看起来仍像同一支笔画出来的。
3. **Agent 画完会自己看一眼。** 它能结构自检（箭头有没有真的吸在框上、标签有没有真的绑在容器里），也能把画板渲染成 PNG 读回来看，于是「挤不挤、文字有没有被裁」这类问题在交给你之前就被发现了。

一句话验收：**你说「画个用户注册流程图」，画板上出现这张图；你接着在上面手绘；再说「把审批那步挪到登录之后」，图真的动了，而你画的东西还在。**

---

## 主要功能

### 画布

| 能力 | 说明 |
| --- | --- |
| 整页画布 | 以整页卡片呈现，左侧导航有固定入口；可从卡片拖出独立窗口（默认 1440×900） |
| 原生手绘 | Excalidraw 0.18.1 的全部手绘能力：选择、箭头、图形、文本、自由绘制、素材库、缩放、撤销重做 |
| 画板管理 | 左侧功能面板：新建、重命名、拖拽排序、删除（鼠标拖整行，触屏长按起拖） |
| 自动保存 | 停止操作约 1.2 秒后落盘，刷新 / 重开 / 重启都还在 |
| 自动取景 | 打开或切换画板时自动把图框进视野；缩放和滚动位置不落盘，不会让内容「跑掉」 |
| 空转不写盘 | 视图变化、重复保存同一份内容都不写文件、不涨版本号（按内容指纹判定） |
| 导出 | 导出 PNG / SVG，保存位置由宿主弹窗让你选；取消、重名冲突、浏览器接管下载会分别提示 |
| 主题跟随 | 画布明暗跟随宿主应用主题；你手动挑的画布底色会被保留，不被主题覆盖 |
| 可移植 | 一板一文件：`<App 数据目录>/boards/<id>.excalidraw`，标准 Excalidraw 格式 + 一个宿主自己的 `hana` 元数据键（Excalidraw 忽略未知键，文件照常能打开） |

### Agent 侧：10 个工具

**画板与文件**

| 工具 | 参数 | 作用 |
| --- | --- | --- |
| `board_list` | 无 | 列出所有画板（id、rev、图元数、最后修改者） |
| `board_create` | `title`（必填） | 新建空白画板，返回 `boardId` |
| `board_rename` | `boardId`、`title` | 改显示名，不动图元 |
| `board_delete` | `boardId` | 删除画板（主画板 `main` 不可删） |

**读写**

| 工具 | 参数 | 作用 |
| --- | --- | --- |
| `board_get` | `boardId` | 读整块画板的图元和 `rev`。**任何修改前都必须先读** |
| `board_write` | `elements`（必填）、`boardId`、`appState`、`baseRev` | 写完整图元列表（全量替换，不是增量补丁）。写完自带一次结构自检 |
| `board_draw_mermaid` | `mermaid`（必填）、`title`、`boardId`、`mode` | 用 Mermaid 画流程图 / 时序图 / 类图 / 状态图 / ER 图 / 甘特图 / 思维导图 |

`boardId` 省略时默认是主画板 `main`。

**自检与预览**

| 工具 | 参数 | 作用 |
| --- | --- | --- |
| `board_check` | `boardId` | 纯静态结构检查：箭头两端是否真的绑定、标签是否真的绑在容器里、绑定有没有指向不存在的元素、`points` 首点是否合法。**不需要打开卡片，也不花钱** |
| `board_render` | `boardId` | 把画板渲染成 PNG 并返回文件路径，Agent 读回来看图。返回值里会说明图源是 `live`（实时画布）还是 `disk`（保存的文件） |
| `board_share` | `boardId`、`note` | 把画板作为只读卡片投进当前对话 |

### Mermaid 画图

流程图、时序图这类有固定结构的图，写 Mermaid 比让模型手算坐标可靠得多：Mermaid 自己排版，间距、连线走向、箭头吸附、标签绑定都是对的。

```
flowchart TD
  A[开始] --> B{格式正确?}
  B -->|是| C[输入验证码]
  B -->|否| D[格式错误]
```

两个行为上的约定，值得你放心：

- **默认新建一个画板文件，不动你已有的任何文件。** 只有你明确点名（「改一下 xx」「加到 xx 里」）时才会写进那个已有画板。
- 转换由打开的卡片页完成（排版需要真实浏览器），所以**画之前白板卡片要开着**。没开时 Agent 会拿到一句明确提示，而不是干等。

### 自检闭环

Agent 画的时候是看不见图的。两个工具把这件事补上：

```
board_draw_mermaid  →  board_check（便宜：结构对不对）  →  board_render（贵：好不好看）
```

`board_render` 有一个好用的性质：**任何打开的页面都能渲染任意一块画板**——正好是白板上开着的那张就取实时画布，否则直接读保存的文件。所以 Agent 想自己闭环、不打断你，可以先 `board_share` 开一张只读预览卡，再用它渲染。整条链路你不需要动手：切画板、开窗口、点保存，一次都不用。

### 随包 skill

安装后自动注册一份 skill（`skills/excalidraw/SKILL.md`）：什么时候该画图、优先用 Mermaid、用哪 6 种图元、语义配色表、字号层级、为什么分支上的「是 / 否」要写在箭头上而不是画成独立文字、以及画完要自检。模型对 skill 的遵循度明显高于工具描述，所以规则放在 skill 而不是塞进工具签名。

### 并发与一致性

- 每次写入都带 `baseRev`（乐观锁）。你读完之后如果有人改过，写入会被**拒绝**并返回当前 `rev`，而不是默默覆盖。
- 冲突不自动合并。Agent 被拒后会重新读一次再改；你的手绘不会被合并逻辑搅乱。
- 后端进程是画板内容的唯一写者，页面和工具走同一条写入路径。

---

## 安装 / 获取

### 方式 A：装打包好的包（普通用户）

<https://github.com/139zbc/HanaAgent-plugins-HanaExcalidraw/releases>
```
app-hana-excalidraw-1.0.0.zip        111,548,541 字节
app-hana-excalidraw-1.0.0.entry.json 宿主安装用的扩展索引条目
```

1. 下载 `app-hana-excalidraw-<version>.zip`。
2. 在 HanaAgent 的扩展 / 应用管理里导入这个包。
3. 确认权限弹窗（见[配置说明](#配置说明)），然后 reload。

### 方式 B：从源码构建

```bash
git clone https://github.com/139zbc/HanaAgent-plugins-HanaExcalidraw.git
cd HanaAgent-plugins-HanaExcalidraw          # 仓库根就是插件本体：目录名必须字面等于 app id
npm install
npm run build        # Vite 构建，产物输出到 ui/
npm run validate     # 官方静态校验
```

- **Hana App SDK 不在 npm 上，但克隆后无需手工准备。** `@hana/app-sdk` 与 `@hana/plugin-sdk` 由 HanaAgent 发行版以 `.tgz` 携带（`<HANA_HOME>/skills/hana-app-creator/assets/sdk/`）。`package.json` 用 `file:./sdk/…` 引用它们，而 `sdk/` 不入库；`npm install` 会先跑 `preinstall`（`fetch-hana-sdk.mjs`）把这两个文件从**你本机的 HanaAgent** 取到 `sdk/`。所以前提只有一个：装了 HanaAgent。HanaAgent 装在非常规位置时用 `HANA_HOME=/path/to/.hanako npm install`，或手动执行 `npm run sdk:fetch`。
- 构建产物必须落在 `ui/`，宿主从 `/api/apps/hana-excalidraw/ui` 这个静态基址加载资源。
- `node_modules/` **必须随打包产物携带**：安装时宿主不会跑 `npm install`（所以它不进版本库，但会进 zip）。
- 入口 html（`board.html` / `preview.html` / `sidebar.html` / `standalone.html`）必须放在**插件根目录**，不能进子目录，否则构建产物的相对路径会让 manifest 里的 `route` 指空。
- 校验脚本走宿主 app 工具链（`%HANA_APP_TOOLS_ROOT%\scripts\validate-app.mjs`）

### 安装位置

```
<HANA_HOME>/apps/hana-excalidraw/   # 宿主从这里加载，目录名必须 == manifest 里的 id
```

---

## 快速上手

### 1. 打开画板

左侧导航点进「白板」。默认有一块主画板 `main`。在空白处随手画两笔，等一两秒，看左侧面板的 `rev` 数字往上跳——那就是落盘了。

### 2. 让 Agent 画图

在对话里直接说人话：

| 你说 | 会发生什么 |
| --- | --- |
| 「用 Mermaid 画个用户注册流程图」 | Agent 新建一个画板文件，把 Mermaid 文本转成图元写进去，箭头绑定到各个形状 |
| 「画个架构图」 | 同上，Agent 会自己选 Mermaid 还是手写坐标 |
| 「把审批那步挪到登录之后」 | Agent 读当前图 → 改坐标 → 写回，你手绘的部分原样保留 |
| 「给这张图加一条超时重试的分支」 | Agent 沿用已有元素 id 新增线，笔迹和图层不动 |
| 「这几点讲的是三件事，分开画三张板」 | Agent 用 `board_create` 拆成多块画板，而不是把不相干的东西塞进一张 |
| 「检查一下刚才那张图有没有画歪」 | Agent 跑 `board_check`，告诉你箭头绑定、标签绑定有没有断 |
| 「你自己看一眼这张图挤不挤」 | Agent 跑 `board_render` 出 PNG 并读回来看 |
| 「把画板发到对话里」 | Agent 调 `board_share`，聊天流里出现一张只读画板卡，带缩放控件 |
| 「列出我有几块画板」 | Agent 调 `board_list` |

Agent 只在**值得画**的时候画：三个以上部件交互、多步流程、有分支决策、要对比两种方案。两三行列表能说清的，它会说而不画。想看图就直接说「画」「图」「可视化」。

### 3. 手动调工具（进阶）

Agent 用的就是下面这些工具。先读：

```jsonc
// board_get  {}
// → "board main  rev=12  8 个图元  {\"rectangle\":6,\"arrow\":2}\nappState: {...}\n\nelements:\n[...]"
```

再写（`baseRev` 用上一步读到的 `rev`）：

```jsonc
// board_write
{
  "baseRev": 12,
  "elements": [
    { "id": "reg-start",  "t": "ellipse",   "x": 435.5, "y": 171, "w": 180, "h": 66,
      "s": "#c2410c", "bg": "#fed7aa", "clean": true, "label": "开始" },
    { "id": "reg-phone",  "t": "rectangle", "x": 425.5, "y": 330, "w": 200, "h": 66,
      "s": "#1e40af", "bg": "#dbeafe", "clean": true, "label": "输入手机号" },
    { "id": "ar-1",       "t": "arrow",     "from": "reg-start", "to": "reg-phone" }
  ]
}
```

### 元素格式

工具读写的是**紧凑格式**，不是 Excalidraw 完整 JSON（完整格式每个元素近 30 个字段，一半是配色和元数据，模型碰它们只会添乱）。后端补全 seed、版本号和颜色默认值。

必填：`id`、`t`、`x`、`y`、`w`、`h`

| 字段 | 含义 |
| --- | --- |
| `id` | 唯一标识。**改已有元素时必须沿用原 id**，笔迹和绑定才保得住 |
| `t` | 图元类型：`rectangle` / `ellipse` / `diamond` / `arrow` / `line` / `text` |
| `x` `y` | 左上角坐标，建议用 `.5` 结尾对齐像素 |
| `w` `h` | 宽高（`arrow` 用 `from`/`to` 时自动算出） |
| `label` | **写在形状里的文字**。双击形状就能改，拖形状字跟着走；**箭头也能写**，分支上的「是 / 否」就该这么写 |
| `text` | 仅独立 `text` 元素（标题、图例、游离注释） |
| `s` / `bg` / `lc` | 描边色 / 填充色 / label 文字色 |
| `lfs` / `fs` | label 字号（形状内默认 20，箭头上默认 16）/ text 字号（默认 20） |
| `from` / `to` | 仅 `arrow` / `line`：两端绑定的元素 id，拖动节点时端点自动跟随 |
| `pts` | 两端都自由的连线，形如 `[[0,0],[60,40]]`，首点必须是 `[0,0]` |
| `dash` | `"dashed"` = 返回 / 异步 / 回环，`"dotted"` = 弱依赖 |
| `op` / `clean` | 透明度 0–100 / 干净直线（技术图建议默认加） |

**判断标准：这个词会跟着图形动吗？会就用 `label`，不会才用独立 `text`。** 分支上的「是」写成独立文字看起来对，但它只是一串坐标——你一拖框，它就留在原地对着一条已经跑掉的线。

### 4. 导出

功能面板底部两个按钮：导出 PNG / SVG。宿主会弹保存对话框让你选位置。宿主无法弹框时会退回写入应用目录，并在提示里说明。

---

## 配置说明

### 权限 / 能力

清单里声明了两项能力，安装或 reload 时宿主会弹权限确认：

| 能力 | 用途 | 不授权会怎样 |
| --- | --- | --- |
| `app/tools.expose-to-model` | 让模型能看到并调用上面那 10 个工具 | Agent 完全无法读写画板 |
| `app/resources.write` | 导出时由宿主弹窗让你选保存位置 | 导出只能退回写入应用目录 |

### 数据存放

```
<App 数据目录>/boards/<id>.excalidraw   # 画板内容，一板一文件
<App 数据目录>/exports/                 # board_render 的出图、导出的回退位置
```

- 内容走文件，不走聊天状态快照（宿主单快照上限 24 KiB，装不下一张图）。
- 宿主存储里只留信号键：当前在看哪块板、Agent 写入后的变更广播。内容与信号各走各的路，不是同一份数据的两个副本。
- **备份**：直接拷 `boards/` 目录即可。路径在 `<HANA_HOME>/app-data/hana-excalidraw/`，而 HANA_HOME 默认是 `~/.hanako`——Windows 上是 `C:\Users\<你的用户名>\.hanako\app-data\hana-excalidraw\boards\`。换机器时把整个 `app-data/hana-excalidraw` 拷过去即可，画板是标准 `.excalidraw` 文件。

### 运行前提

`board_draw_mermaid` 与 `board_render` 需要**至少一个打开的白板页面**（白板卡片或聊天里的只读预览卡）——这两步的排版与栅格化必须由真实浏览器完成。其余工具（读写、列表、删除、结构自检）纯后端，随时可用。

### 开发期环境变量

| 变量 | 用途 |
| --- | --- |
| `HANA_APP_TOOLS_ROOT` | `validate` / `smoke` 脚本使用的宿主 app 工具链路径 |

### 页面级自诊断

卡片页带内联启动诊断：页面起不来时会把原因写进 `window.__boardDiag` 并改文档标题。排障先看这两处。

---

## 兼容性与依赖

| 项 | 版本 / 说明 |
| --- | --- |
| 宿主 HanaAgent | `minAppVersion: 0.1028.0` |
| Manifest | `manifestVersion: 2`（v2 App） |
| Hana App SDK | `@hana/app-sdk` 0.1050.9 / `@hana/plugin-sdk` 0.0.0（均 Apache-2.0）——**不在 npm 上**，随 HanaAgent 发行版以 `.tgz` 提供，`npm install` 时自动取到 `sdk/` |
| Excalidraw | `@excalidraw/excalidraw` 锁定 `0.18.1`（MIT，ESM） |
| Mermaid | 画流程图 / 时序图等；每种图一个懒加载分块，不进首屏 |
| React | `react` / `react-dom` `19.2.0`（Excalidraw 的 peer 范围 17/18/19） |
| 构建 | Vite `^7` + `@vitejs/plugin-react` `^5`（仅构建期，运行时不依赖） |
| Node | v24.18.0 |
| 平台 | 开发与验证都在 Windows 11 上完成，macOS / Linux 未实测 |

几条硬性事实：

- **离线可用。** 卡片页面没有外网权限，字体（9 个族、234 个子集文件）与其他静态资源全部自托管，运行时不请求外部 CDN。
- **`node_modules` 随包携带**，安装时不执行 `npm install`。
- **包体积在 100 MB 量级**，大头是 `node_modules` 和自托管字体。

---

## 常见问题

**Q：Agent 写完提示「写入被拒绝：当前是 rev N，你基于 rev M 修改」。**
有人（多半是你）在 Agent 读完之后又改了画板。Agent 会重新读一遍再改。这是设计内的行为。

**Q：Agent 画图会覆盖我现有的画吗？**
`board_draw_mermaid` 默认**新建一个文件**，不动你已有的画板；只有你明确点名（「改一下 xx」「加到 xx 里」）它才写进那块板。所以「再画一张」永远是安全的。想让新图接在同一张下面，说「加到 xx 里」即可。

**Q：Mermaid 画图提示「等不到回应」。**
Mermaid 的排版要在真实浏览器里做，白板卡片得开着。打开白板卡再说一次就行。

**Q：`board_render` 说没有可用的页面。**
同样需要至少一个打开的白板页面。让 Agent 先 `board_share` 在对话里开一张只读预览卡，它就能自己闭环了——**渲染任意一块画板都不需要你切过去**。

**Q：Agent 说「结构完好」，可图就是难看。**
`board_check` 查的是数据层面的事实：箭头有没有真的吸在框上、标签有没有真的绑在容器里、绑定有没有指向不存在的元素。它数不出「挤」和「被裁」。让 Agent 跑一次 `board_render` 看图。

**Q：我画的东西被 Agent 覆盖了。**
`board_write` 是全量替换，所以它必须先 `board_get`。内置 skill 把「先读再写」写成硬约定、`board_write` 也会自带结构自检，但服务端没有「保留未知元素」的兜底。重要内容建议先导出留一份。

**Q：白板卡片一片空白 / 白屏。**
先看卡片标题和 `window.__boardDiag`——页面起不来时会把原因写在那里。常见原因是装的是不完整的包（`ui/` 产物或字体缺失），或宿主版本低于清单声明的 `minAppVersion`。

**Q：改了代码但没生效。**
宿主没有热重载。必须 reload App 并重新打开卡片页面。插件健康和工具通道通不通是两件事：改完插件文件后别连着重试调用，先看日志确认重启，再用别的 App 探一次通道。

**Q：聊天里那张白板卡能编辑吗？**
不能。那是 `board_share` 投出来的只读预览（编辑外壳已隐藏，只保留缩放）。要改请回到白板。



**Q：支持几个人同时画一张板吗？**
当前是单机单人模型：画板数据在本机范围，Agent 与你共享同一块板的读写，但没有多人光标与实时同步协议。

**Q：手机上怎么给画板排序？**
长按行再拖。面板是竖向滚动的列表，手指落下就移动在触屏上只能表示滚动，所以触屏走长按起拖（350ms），鼠标则是整行 5px 阈值拖动。

**Q：能一次画多少？**
单文件超过约 512 KB 会触发宿主存储告警，超过 16 MB 硬失败。日常画板远到不了这个量级；真到的时候拆成多块画板（`board_create`），单张图 20–40 个图元最好读。

---

## 开发

### 目录结构

```
<仓库根>（= 插件本体，目录名必须字面等于 manifest 里的 id）
├─ README.md
├─ LICENSE                          # MIT
├─ manifest.json                    # v2 清单：id = hana-excalidraw，卡片与能力声明
├─ index.js                         # defineApp 入口：注册路由与工具
├─ board.html                       # 主画布页（必须在根目录）
├─ preview.html / sidebar.html / standalone.html
├─ lib/                             # 后端：boards 文件仓库、CAS 写入队列、10 个工具、
│                                   #       Mermaid 请求、结构检查器、渲染请求
├─ src/                             # 前端：ExcalidrawBoard.jsx、各页面入口、Mermaid/渲染桥、样式
├─ skills/excalidraw/SKILL.md       # 随包 skill
├─ assets/                          # 应用图标与卡片封面（封面由构建拷进 ui/assets/）
├─ package.json / package-lock.json / vite.config.mjs
├─ fetch-hana-sdk.mjs                # preinstall：从本机 HanaAgent 取 SDK tgz 到 sdk/
├─ ui/                              # 构建产物（npm run build 生成，不入版本库）
├─ node_modules/                    # 依赖（不入版本库，但进打包产物）
└─ sdk/                             # HanaAgent SDK 的 tgz（不入版本库，见 .gitignore）
```

开发期的检查与测试脚本（`scripts/`，53 个）**刻意留在仓库之外**——打包器不排除任何文件，仓库里若带上它们就会跟着进包。跑它们需要在工作台容器里执行。

```bash
node scripts/check-local-imports.mjs    # 静态检查：用了却没 import 的符号
node scripts/test-board-files.mjs       # 测试：一板一文件、命名、迁移、降级
```

---

## License

本项目采用 **MIT** 许可证，完整文本见仓库根目录的 [`LICENSE`](LICENSE)，版权人 139zbc（2026）。

依赖与上游许可：

- [Excalidraw](https://github.com/excalidraw/excalidraw) —— MIT
- [Mermaid](https://github.com/mermaid-js/mermaid) —— MIT
- [HanaAgent](https://github.com/liliMozi/openhanako)  —— Apache License 2.0

---

## 致谢

- [Excalidraw](https://github.com/excalidraw/excalidraw) 及其作者，画布本身的一切
- [Mermaid](https://github.com/mermaid-js/mermaid)，让流程图不必手算坐标
- [HanaAgent](https://github.com/liliMozi/openhanako) 的 v2 App SDK 与宿主机制
