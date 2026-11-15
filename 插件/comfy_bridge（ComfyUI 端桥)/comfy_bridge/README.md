# chip-prompt-tool 联动桥 · ComfyUI 节点包（ComfyUI 运行插件）

> 这是**装在 ComfyUI 那边**的插件，不是主程序插件。
> 文件夹里**没有 `plugin.json`**，所以主程序「🧩 插件」浮层不会加载它——它只归 ComfyUI 用。

它干三件事：

1. **注册一组自带 CORS 头的 `/chip/*` HTTP 路由**，让主程序面板能直接 `fetch` 进来（主程序是 `file://` 页面，`fetch` 标准 ComfyUI API 会被跨域拦掉，所以必须有一层带 CORS 的桥）。
2. **提供一批「联动」小节点**，把主程序面板填的提示词 / 参数 / 模型 / LoRA / 图片，注入到你的工作流里，对原工作流只改连线、不改逻辑。
3. **附带一个 ComfyUI 前端网页扩展**（`web/js/chip_canvas.js`），让面板「开始」运行时由 ComfyUI 网页自己排队——节点高亮、运行按钮变色、采样预览、原生报错弹窗全部和人工点「运行」一模一样。

---

## 一、安装

把整个 `comfy_bridge（comfyui）` 文件夹复制到 ComfyUI 的自定义节点目录，**必须是 `custom_nodes\` 的直接子目录**（不要套一层别的文件夹，否则 ComfyUI 不会加载）：

```
ComfyUI\custom_nodes\comfy_bridge\
    ├─ __init__.py
    ├─ chip_routes.py         # /chip/* 路由 + PromptServer 包装（自动捕获工作流）
    ├─ node_chips.py          # 联动节点定义
    ├─ config.json            # 共享图片路径等配置
    ├─ web\js\chip_canvas.js   # ComfyUI 前端扩展（浏览器排队通道）
    └─ README.md
```

**重启 ComfyUI**。启动后控制台应出现：

```
[chip-prompt-tool 联动桥] /chip/* 路由已注册（带 CORS）
```

看到这句就说明路由、节点、前端扩展全部加载成功。

> - 秋叶启动器一般在 `...\ComfyUI-aki-v3\ComfyUI\custom_nodes\`。
> - 依赖全是 ComfyUI 自带的（`aiohttp` / `PIL` / `numpy` / `torch`），**不用装任何新东西**。
> - **端口不是 8188 也不要改这里**：主程序面板会自动探测 `8188 / 8189 / 8199 / 8181 / 8080 / 8000`，命中 `/chip/ping` 就自动改地址并记住。如果你想手动指定，在主程序 `ComfyUI` 面板里填地址即可。
> - 因此 ComfyUI **不用加** `--enable-cors-header` 之类的参数，主程序也不用起服务。

---

## 二、文件结构说明

| 文件 | 作用 |
|---|---|
| `__init__.py` | 节点包入口：导出节点映射、声明 `WEB_DIRECTORY="./web"`、调用 `chip_routes.register()` 注册路由；路由注册失败时节点仍可用。 |
| `chip_routes.py` | 全部 `/chip/*` 路由 + 包装 `PromptServer` 的 `/prompt` 处理器做「自动捕获工作流」。 |
| `node_chips.py` | 联动节点（`CATEGORY = "chip-prompt-tool/联动"`）。 |
| `config.json` | 共享图片文件路径配置（见第七节）。 |
| `web/js/chip_canvas.js` | ComfyUI 网页扩展：监听 `chip-canvas-request`（推回当前画布）和 `chip-canvas-submit`（替网页排队）。 |

---

## 三、HTTP 路由总表（`/chip/*`，全部带 CORS）

主程序面板**只跟这些路由打交道**，路由内部再转发到 ComfyUI 自带的标准 API，不碰 ComfyUI 内部对象。

| 方法 | 路由 | 作用 |
|---|---|---|
| GET | `/chip/ping` | 连通性测试，返回桥名与时间戳。面板自动探测端口时就调它。 |
| GET | `/chip/status` | 返回 排队 / 执行中 / 空闲 + 队列剩余数 + **阶段式进度**（排队 20% / 执行 60% / 完成 100%）。不接 WebSocket。 |
| GET | `/chip/options` | 读取 ComfyUI 本机**真实的**大模型 / LoRA 文件列表，返回给主程序做下拉（模型选择、LoRA 多选用）。 |
| POST | `/chip/start` | 重跑「最近一次 ComfyUI 提交过的工作流」（从 `/history` 取工作流提交）。 |
| POST | `/chip/stop` | 中断当前执行（转发 `/interrupt`）。 |
| POST | `/chip/upload` | 接收主程序送来的图片字节 → 写成共享 `input.png`（供送图进工作流用）。 |
| GET | `/chip/images` | 读最近生成的图片 → 返回 base64（**只传内存，不在主程序落盘**）。 |
| GET | `/chip/workflow` | 取当前已载入的图纸（链接源 / 上传缓存 / 自动捕获）。 |
| GET | `/chip/workflows` | 列出 ComfyUI 用户工作流库里的 `.json`（`user` / `default` / `workflows` 等目录）。 |
| POST | `/chip/workflow` | 载入工作流（支持绝对路径 / 链接源 / 上传缓存三种来源 + remap 替换）。 |
| POST | `/chip/workflow/check` | 检查工作流里引用的模型 / LoRA 在本机是否存在；列「仍无法自动匹配」的项。 |
| POST | `/chip/canvas` | ComfyUI 前端扩展**推回的当前画布**（`graphToPrompt` 的 output / workflow）。 |
| POST | `/chip/queued` | 前端扩展用 `api.queuePrompt` 排队后的**回执**（成功 / 校验失败具体错误）。 |
| POST | `/chip/start_canvas` | **运行当前画布**：先拉画布 → 注入联动值 → 经浏览器排队通道提交。 |

> **自动捕获工作流**：`register()` 时会包装 `PromptServer` 的 `/prompt` 处理器，在 ComfyUI 每次本地提交（包括你手动点 Queue）时把工作流暂存起来，面板 `/chip/start` 才能复用。

---

## 四、联动节点（菜单 `chip-prompt-tool/联动`）

每个节点只管一件事，输出一根线连到标准节点对应的控件即可，**最小化对原工作流的改动**。节点上无控件，值由主程序面板在「开始」时经 `hidden` 输入注入（大模型 / LoRA 例外，它们有真实下拉）。

### 1. 纯注入节点（无控件，值由面板注入）

| 节点名 | 输出 | 通常连到 |
|---|---|---|
| 提示词(联动) | `STRING` × 2（正向 / 负向） | 两个口分别连到 正 / 负 `CLIP文本编码` 的 `text` |
| 种子 | `INT` | `KSampler` 的 `seed` |
| 步数 | `INT` | `KSampler` 的 `steps` |
| CFG | `FLOAT` | `KSampler` 的 `cfg` |
| **全注入(联动)** | `STRING`×2 / `INT`×2 / `FLOAT` / `LATENT` / 模型 / `LORA_STACK` / `IMAGE`（共 9 个输出口） | 一个节点取代上面分散的提示词/种子/步数/CFG/Latent/大模型/LoRA堆/图像输入；原各节点仍保留，按需选用 |

> **全注入(联动)**：节点上只有一个控件（模型下拉 = ComfyUI 真实模型列表），其余全部由面板「开始」时注入；没填的走兜底（Latent 512×512、图像 64×64 占位）。输出口顺序：正向提示词 → 负向提示词 → 种子 → 步数 → CFG → Latent → 模型 → LoRA堆 → 图像。它的「LoRA堆」口接「应用LoRA堆(联动)」（这个节点仍保留）再进采样器。

> 面板没填某项，对应节点输出空值（字符串为 `""`，整型为 `0`），**不会让工作流崩**。

### 1.5 Latent(联动) `ChipLatent`

- 无控件，由面板「开始」时注入 **宽 / 高**，输出 **ComfyUI 通用 `LATENT`**——与标准「空Latent」**同类型、同数据格式**（`torch.zeros([1, 4, h÷8, w÷8])`，批量 1）。
- **直接连 KSampler 的 `latent_image` 输入**（或任何吃 Latent 的节点：KSampler(高级) / Latent放大 / 图生图入口），**「空Latent」节点可以整个删掉**——一根线代替原来「两个 INT 节点 + 空Latent 两个控件」。
- 宽高自动向下对齐到 8 的倍数（VAE 下采样要求），面板没填时默认 512×512，不会让工作流崩。

### 2. 大模型选择 `ChipCheckpoint`

- `INPUT_TYPES` 的下拉是 ComfyUI 真实扫描到的 `checkpoints` 模型列表；**输出类型也用同一份列表**（这样在「这版校验把目标候选列表原样和来源类型比较」的 ComfyUI 上也能通过类型校验）。
- 输出 `ckpt_name` → 连到 `Checkpoint加载器` 的「模型」控件。
- **连法**：右键加载器的「模型」控件 → 选「转换为输入」（或把线头拖到控件文字上自动转），再接过来。原工作流零改动。
- 面板在下拉选的模型会在「开始」时覆盖节点上的值。

### 3. LoRA 堆 `ChipLoRA`（联动）

- 无控件，输出一个 `LORA_STACK`（条目格式与 Comfyroll 的 `CR LoRA Stack` 一致：`{lora_name, strength_model, strength_clip}`）。
- 可选输入 `lora_stack` 可再接另一个堆（堆串堆），也能直接接 Comfyroll 的堆。
- 输出可接本包「应用LoRA堆(联动)」或 Comfyroll「应用LoRA堆」。
- 堆里的内容（多个 LoRA + 权重）全部由面板多选注入。

### 4. 应用LoRA堆(联动) `ChipApplyLoRA`

- 输入：`MODEL` / `CLIP` + 一个 `LORA_STACK`（本包「LoRA堆(联动)」或 Comfyroll「CR LoRA Stack」的输出都行）。
- 按顺序把堆里所有 LoRA 叠加到模型上，输出 `MODEL` / `CLIP`。
- 堆为空（没接或空堆）时**原样透传**，不报错。

### 5. 图像输入 `ChipInputImage`

- 输出 `IMAGE`。base64 由主程序面板「送图进工作流」时注入（`hidden` 输入，节点上无控件）。
- 把它**手动连到**工作流里需要图片的位置（常见是 `Load Image` 之后的 img2img / 图生图 / 上采样入口；VAE Decode 之前的空 Latent 不用它）。想接几个接几个。
- 没送过图时返回一个 64×64 深灰占位图并在控制台提示，不会让工作流崩。

### 6. 生成图返回 `ChipOutputImage`

- 输入 `IMAGE`，把工作流最后的图写进 ComfyUI 临时目录（**不落盘到 output**），历史记录带上 `images`，桥的 `/chip/images` 据此把生成图取回主程序面板显示。
- **提示**：工作流里已经有「保存图像」节点的话，不加这个也能显示。加它只是为了在没有保存节点时也能回传。

---

## 五、前端扩展与「运行当前画布」浏览器排队通道

这是让面板运行「像用户自己点运行」的关键。

### 原理

ComfyUI 界面上的运行动画（节点高亮、运行按钮变色、采样预览、原生报错弹窗）是由 ComfyUI 服务端通过 WebSocket 广播的执行事件驱动的。但**节点高亮只对「浏览器自己提交的那个任务」生效**——如果面板用自己的标识直连 `/prompt`，网页只认全局进度条，画布上没动画。

解决：面板「开始（运行当前画布）」时走浏览器排队通道——

```
面板 POST /chip/start_canvas
  → 桥 WebSocket 广播 chip-canvas-request
  → ComfyUI 网页里的 chip_canvas.js 收到 → 调 graphToPrompt() 把当前画布推回 /chip/canvas
  → 桥注入联动值 → 再广播 chip-canvas-submit（带注入好的 prompt/workflow）
  → chip_canvas.js 调 api.queuePrompt()（和手点「运行」同一条代码路径）
  → 节点高亮 / 运行按钮 / 预览 / 原生报错弹窗 全部正常
  → 排队结果回执 /chip/queued → 面板显示
```

- **等价于用户自己在 ComfyUI 点运行**，只是图里的参数已被面板注入。
- 校验失败时 ComfyUI 会像手动运行一样**弹原生红框**，面板也收到具体错误。
- **回退**：若网页没开 / 扩展没加载（旧页面没强刷），桥自动回退到直连 `/prompt` 提交（功能不丢，只是没有画布动画）。

### 使用前提

- **ComfyUI 网页必须开着**（那些动画是网页前端收到 WS 事件后画出来的；关了网页就没有画面，但生成照常）。
- 改过 `chip_canvas.js` 后，**ComfyUI 网页 Ctrl+F5 强刷**（扩展脚本不会热更）。
- 之前版本「在 ComfyUI 里改画布后先手动 Queue 一次」的约束，在「运行当前画布」模式下已不需要——它直接读界面上正在编辑的活画布。

---

## 六、完整运行流程（面板「▶ 开始」默认 = 运行当前画布）

1. 主程序面板连接测试通过（**已连接 ✓**）。
2. 你在 ComfyUI 界面上摆好工作流，并接上需要的联动节点（提示词 / 种子 / 模型 / LoRA / 图像输入 / 生成图返回）。
3. 主程序面板填提示词、参数、选模型 / LoRA、选种子（可勾随机模式）。
4. 点「▶ 开始」→ 走第五节浏览器排队通道 → ComfyUI 网页自己跑 → 你能在 ComfyUI 界面上看到节点逐个高亮、进度条、预览。
5. 跑完面板自动 `GET /chip/images` 取回生成图显示；也可手动「🔄 刷新生成图」。
6. 选中一张生成图 → 点「送图进工作流」的三个来源之一，把图送回工作流再跑（图生图 / 放大）。

---

## 七、config.json

```json
{
  "input_file": "shared/input.png"
}
```

- `input_file`：主程序「送图进工作流」写入、节点「图像输入」读取的共享图片文件位置（相对本节点包目录）。
- 也可用环境变量 `CHIP_PROMPT_TOOL_COMFY_INPUT` 覆盖。

---

## 八、排错

| 现象 | 处理 |
|---|---|
| 控制台没出现「/chip/* 路由已注册」 | 确认 `comfy_bridge` 是 `custom_nodes\` 的**直接子目录**，且**重启过** ComfyUI。 |
| 面板连接测试「连不上」 | 确认 ComfyUI 已启动、节点包已加载、已重启。面板会自动扫常见端口；仍失败就手动填 `--port` 地址保存。 |
| 面板「开始」后 ComfyUI 界面没动画 | 检查 ComfyUI 网页是否开着、是否 Ctrl+F5 强刷过（扩展脚本要重新加载）。 |
| 开始后校验失败（原生红框） | 看红框里的具体节点错误；常见是联动节点没接对控件类型。面板也会收到 `/chip/queued` 回执里的 `node_errors`。 |
| `ChipCheckpoint` 连线报「Return type mismatch」 | 这是某些版本 ComfyUI 把目标控件候选列表原样与来源类型比较导致的；本节点已用「真实候选列表」作为输出类型规避。确认用的是本包提供的节点而非自建。 |
| 送图后「图像输入」节点没变 | 检查画布上该节点是否已连线；`IS_CHANGED` 靠文件 mtime，重跑一次即可。 |
| 生成图不显示 | 确认工作流里有「保存图像」节点，或加了本包「生成图返回」节点接最终 IMAGE。 |

---

## 九、配套主程序插件

- `插件\comfy_panel（comfyui）\`：主程序侧的 **ComfyUI 控制面板**（显示生成图、开始/停止、进度、送图进工作流）。
- `插件\photo_library（图片库）\`：独立纯照片库（可选，送图来源之一）。

这三个文件夹**互不依赖**，删掉任一个其余照常。
