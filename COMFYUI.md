# 魔女画匣 · ComfyUI 版

在 [witch-paintbox](https://github.com/Elainadesne/witch-paintbox) 的基础上新增了第五支画笔：**ComfyUI**。
NAI / GPT（OpenAI 兼容）/ Gemini / Grok 四条原有通道的行为、配置和界面全部保持不变。

---

## 1. 安装

### 1.1 推送到你的 GitHub（酒馆只认仓库地址时走这条）

本目录**已经初始化成 git 仓库并提交好了**（分支 `main`，239 个文件，工作区干净），你只需要建远端然后推上去。

**第 1 步：在 GitHub 建空仓库**

- Repository name 填 `witch-paintbox-comfyui`
- 可见性选 **Public**（私有仓库酒馆 clone 会失败，除非在服务器上配凭据）
- ⚠️ **不要勾** Add a README file / Add .gitignore / Choose a license —— 本地已经有这些文件，勾了首推会冲突

**第 2 步：推送**

```bash
cd "G:\WorkBuddy\2026-11-10-15-22-23\witch-paintbox-comfyui"

git remote add origin https://github.com/YoshinoA123/witch-paintbox-comfyui.git
git push -u origin main
```

推送要认证，GitHub 已经不认账号密码了，二选一：

- **PAT**：GitHub → Settings → Developer settings → Personal access tokens → 生成一个带 `repo` 权限的 token，密码框里粘 token
- **GitHub Desktop**：把这个目录拖进去，点 Publish repository，最省事

如果报 `rejected` / `failed to push some refs`，说明远端多了个初始 README，直接覆盖（远端是空的，没有东西会丢）：

```bash
git push -u origin main --force
```

**第 3 步：在酒馆里装**

扩展 → 安装扩展 → 填：

```
https://github.com/YoshinoA123/witch-paintbox-comfyui
```

确定后刷新页面，右下角出现桌宠缇娅就是装好了。

> 安装后的文件夹名 = 仓库名；界面里显示的名字 = `manifest.json` 的 `display_name`（当前是「魔女画匣 · ComfyUI」）。

### 1.2 本地文件夹安装（如果你的酒馆支持）

把 `witch-paintbox-comfyui` 文件夹放进：

```
SillyTavern/data/YoshinoA123/extensions/third-party/witch-paintbox-comfyui
```

> 和官方版「魔女画匣」同时安装时，两个插件都会画一只悬浮球和一只桌宠，会互相遮挡。**建议只启用其中一个**。

### 1.3 以后改完代码怎么更新

酒馆跑的是仓库里提交的 `dist/`，**它自己不会编译**。所以改完源码必须重新构建再推：

```bash
cd "G:\WorkBuddy\2026-11-10-15-22-23\witch-paintbox-comfyui"

npm run build        # tsc 编译到 dist/
git add -A
git commit -m "更新 ComfyUI 面板"
git push
```

然后回酒馆：扩展管理里点更新，或点画匣标题栏的铃铛检查更新（这个仓库是 git 安装的，铃铛能正常工作）。

> 判断有没有漏推：`git status` 显示 `nothing to commit` 就说明 dist 已经是最新的。

---

## 2. 让浏览器能直连 ComfyUI

本版只做浏览器直连（不做酒馆后端转发）。酒馆和 ComfyUI 端口不同，浏览器视为跨域，必须让 ComfyUI 放行：

```bash
python main.py --enable-cors-header
```

- 默认地址 `http://127.0.0.1:8188`
- 如果 ComfyUI 在另一台机器上，填 `http://192.168.x.x:8188`，同样要带 `--enable-cors-header`
- 如果给 ComfyUI 套了需要令牌的反向代理，可以把令牌填进连接配置，请求会带 `Authorization: Bearer <令牌>`（不填也可以，ComfyUI 本身不需要）

---

## 3. 三步出第一张图

1. 设置面板 → **更多画笔** → **ComfyUI**
2. 「服务地址」填 `http://127.0.0.1:8188`，点 **测试连接**（会显示版本和显卡），再点 **保存**
3. 粘贴工作流 → 点 **校验工作流** 看识别结果 → 点 **点击生成图片**

---

## 4. 怎么导出工作流

必须是 **API 格式**：

| ComfyUI 版本 | 操作 |
| --- | --- |
| 新版（有菜单栏） | 菜单 → `Workflow` → `Export (API)` |
| 旧版 | 设置里勾选 `Enable Dev mode Options`，画布上会出现 `Save (API Format)` |

界面格式（带 `nodes` / `links` 的 JSON）会被明确拒绝并提示你重新导出，不会静默失败。

---

## 5. 自动识别规则

粘进去就直接能用，**不需要改工作流**。识别逻辑：

| 目标 | 怎么找 |
| --- | --- |
| 正面 / 负面提示词 | 从采样器的 `positive` / `negative` 连线向上游追，命中 `*TextEncode*` 一类节点。穿过 `ConditioningCombine`、`FluxGuidance`、`ControlNetApply` 等中转节点继续追；遇到 `ConditioningZeroOut` 视为「这一路本来就是空负面」 |
| 采样参数 | 优先 `KSampler` / `KSamplerAdvanced`；拆分式工作流（`RandomNoise` + `CFGGuider` + `KSamplerSelect` + `BasicScheduler`）按字段名兜底写入 |
| 画幅 / 批量 | 从 `latent_image` 连线找到带 `width` / `height` 的 `EmptyLatentImage` 一类节点 |
| SDXL 双文本 | `CLIPTextEncodeSDXL` 的 `text_g` / `text_l`，Flux 的 `clip_l` / `t5xxl` 会一起写 |

点 **校验工作流** 会逐行列出：识别到哪个节点、多少节点、有没有警告。生成时的实际写入结果也会回显在面板上。

---

## 6. 占位符（可选，优先级最高）

想让某个值绝对写死，就在工作流对应字段里写占位符。占位符占住的字段，自动识别不会再碰。

| 占位符 | 含义 |
| --- | --- |
| `%prompt%` | 正面提示词 |
| `%negative_prompt%` | 负面提示词 |
| `%steps%` | 步数 |
| `%cfg_scale%` | CFG |
| `%seed%` | 种子 |
| `%sampler_name%` | 采样器 |
| `%scheduler%` | 调度器 |
| `%width%` | 宽度 |
| `%height%` | 高度 |
| `%batch_size%` | 单批张数 |

两种写法都支持，**必须带引号**（否则 JSON 本身就不合法）：

```json
"text": "%prompt%"                       // 整值替换，数值会自动还原成数字
"text": "masterpiece, %prompt%, best quality"   // 子串拼接
```

---

## 7. 采样参数说明

- **步数 / CFG / 种子 / 单批张数**：直接覆盖工作流里的值
- **采样器 / 调度器**：留空 = 沿用工作流原值；填了才覆盖（输入框带常用值联想，但服务端有什么就能填什么）
- **画幅**：需要和模型训练分辨率匹配；ComfyUI 不像 NAI 强制 64 倍数，所以步进放宽到 8
- **AI 动态画幅**：和其他通道共用同一套逻辑，配图标记里的 7 种画幅会映射成宽高
- **负面提示词**：ComfyUI 原生支持，画师工坊的负面栏这一路是真的生效的

---

## 8. 队列与进度

- 面板会实时显示 `等待 ComfyUI 执行 · 队列第 N 位` 和 `采样 3/28 步`
- 步数来自 ComfyUI 的 WebSocket 广播；WebSocket 连不上（比如被反代挡了）会自动退回只看队列位置，不影响出图
- 点「取消等待」会删掉自己那一条队列项；只有确认自己是正在运行的那条时才发 `/interrupt`，不会误杀别人的任务

---

## 9. 常见问题

| 现象 | 原因与处理 |
| --- | --- |
| 无法连接 ComfyUI | 没加 `--enable-cors-header`；或地址/端口不对；先点「测试连接」看具体报错 |
| ComfyUI 拒绝了该工作流（400） | 工作流里的模型文件名不存在、节点参数越界。面板会带出 ComfyUI 原始报错 |
| 任务完成但输出里没有图片 | 工作流末端需要 `SaveImage`；或输出节点选错了，可在「占位符与进阶参数」里指定输出节点 |
| 等待超时 | 首次加载大模型会慢，把「等待超时」调到 600 秒 |
| 负面词没生效 | 该工作流没有负面输入（Flux 常见），校验报告会写「负面提示词 → 未接入」 |
| 出图尺寸和设置不一致 | 工作流里的画幅节点不在采样器上游，插件找不到就无法覆盖；报告里会有警告 |

---

## 10. 开发

```bash
npm install
npm run build     # tsc → dist/
npm test          # 51 项测试
```

改动集中在两个新文件：

- `src/comfyui-workflow.ts` — 工作流解析、节点追溯、占位符注入（纯函数，无网络）
- `src/comfyui-image.ts` — 连接校验、`/prompt` 提交、`/queue` 轮询、`/history` 取名、`/view` 取图、取消与 WebSocket 进度

接入点：`image-settings.ts`（第五个 provider）、`image-provider.ts`（分发）、`image-view.ts` + `image-config.ts`（界面）、`image-history.ts` / `image-gallery.ts` / `config-archive.ts` / `config-merge.ts`（历史与配置归档）。

上游原版：<https://github.com/Elainadesne/witch-paintbox>（作者 Elainadesne）。
本扩展沿用其许可与设计语言，仅新增 ComfyUI 通道。
