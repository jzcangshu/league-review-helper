# 入团申请材料审核助手

这是一个本地运行的入团申请材料审核工具。它把“名单 Excel、PDF 资料、TXT 审核结果”组织成统一目录结构，在网页里左侧录入审核结果、右侧预览 PDF，并提供一个 Codex skill 用于新增学校前的准备和审核完成后的结果回写。

项目默认只在本机运行，不需要上传学生材料到第三方服务。

<img width="2560" height="1440" alt="运行截图（脱敏）" src="https://github.com/user-attachments/assets/cc6eeba5-4ab8-491f-9573-a6ba7d40b27f" />

## 快速上手

### 0. 一图理解操作逻辑&目录架构

<img width="1672" height="941" alt="操作流程示意图" src="https://github.com/user-attachments/assets/3f626a87-83bc-481c-8c73-fc4245e4820c" />


### 1. 准备环境

这一步的目的，是让本地机器同时能运行网页审核工具和 Excel 处理脚本。网页部分由 Node.js 启动，名单读取和回写由 Python 脚本完成。

需要安装：

- Node.js 18 或更高版本
- Python 3.10 或更高版本
- Python 依赖：`openpyxl`

如果需要生成或修改示例资源，可额外安装 `reportlab`；日常使用不需要。

### 2. 启动网页审核工具

仓库里已经带了一套虚构示例资源，所以第一次启动时不需要准备真实学校材料。启动网页后，你会看到左侧学生列表和审核结果输入框，右侧是对应 PDF 预览；网页读写的审核结果都在 `审核结果/<学校名>` 目录下。

Windows 用户可双击：

```powershell
start-review.cmd
```

或在命令行运行：

```powershell
cd review-web
node server.js
```

默认地址为 `http://127.0.0.1:4173`。如果端口被占用，服务会自动尝试后续端口；`start-review.ps1` 会按新进程实际监听端口打开浏览器。

### 3. 使用示例资源体验

为方便您快速上手、理解项目需要什么目录结构，本项目提供了一套示例数据，包括：Excel 名单、PDF 资料、审核结果 TXT，网页启动后会自动加载。

```text
examples/
  示例中学/
    示例中学团员名单.xlsx
    入团申请资料/
      赵一诺.pdf
      李铭.pdf
      王小雨.pdf
审核结果/
  示例中学/
    赵一诺_审核结果.txt
    李铭_审核结果.txt
    王小雨_审核结果.txt
```

示例中故意设置了一个姓名笔误：Excel 里是 `李明`，资料文件是 `李铭`。这用于演示高置信模糊匹配和回写规则。

### 4. 准备一个真实学校

相信你已经会用本项目了，开始导入你需要审核的真实数据吧！请确保你的文件架构符合以下示例结构，其中包含：名单 Excel 和一批 PDF。

准备脚本稍后会根据 PDF 文件名自动化创建空的审核结果 TXT，并核对名单和资料是否对得上，这部分内容我们稍后详细解释，先去准备数据吧⬇️。

请把学校资料放在工作区内，例如：

```text
某某中学/
  某某中学团员名单.xlsx
  入团申请资料/
    张三.pdf
    李四.pdf
```

然后选择一种方式执行准备。

方式 A：人工运行脚本，适合：目录结构清楚、文件名规则稳定的情况。

```powershell
python codex-skills/league-review-prep/scripts/prepare_school_review.py --school-dir "某某中学" --update-web-sources
```

方式 B：使用本项目提供的 Codex skill，让 Codex 帮你判断哪个 Excel、哪个 PDF 目录、哪些姓名差异需要提醒。适合：真实学校材料格式不统一、文件夹命名混乱、姓名可能有错别字的情况。

可以直接对 Codex 说：

```text
使用 league-review-prep，帮我为“某某中学”做审核前准备。
```

脚本会：

- 自动寻找 Excel 中的 `姓名` 列
- 自动寻找 PDF 最多的资料目录
- 按 PDF 文件名创建 `审核结果/<学校名>/<人名>_审核结果.txt`
- 报告“只在名单出现”“只在资料出现”“疑似姓名字形不一致”
- 更新 `review-web/sources.json`，让网页工具能直接导入该学校

做完这一步后，当前学校已经具备网页审核所需的结构：PDF 仍留在原资料目录，审核结果 TXT 统一放在 `审核结果/<学校名>`。如果报告里出现姓名差异，应先人工看一眼，避免后续把审核结果写到错误学生名下。

### 5. 审核完成后回写 Excel

这一步发生在你已经通过网页把一个学校全部审核完之后。

此时，每个人的审核结论都分散保存在 `审核结果/<学校名>/<人名>_审核结果.txt`，但学校原始 Excel 还没有被更新。

回写脚本会把所有 TXT 的内容整合，自动填入 Excel 的 `入团志愿书问题备注` 列。

同样可以人工运行：

```powershell
python codex-skills/league-review-prep/scripts/prepare_school_review.py --school-dir "某某中学" --write-excel
```

也可以让 Codex 使用 skill 执行：

```text
某某中学已经全部审核完毕，把审核结果写回 Excel。
```

脚本会把 `审核结果/<学校名>/*_审核结果.txt` 写入该校 Excel。没有对应资料或审核结果的名单行，会用红色字写 `无资料`。

如果出现脚本无法确信的姓名对应关系，可显式指定：

```powershell
python codex-skills/league-review-prep/scripts/prepare_school_review.py --school-dir "某某中学" --write-excel --alias "Excel姓名=审核结果姓名"
```

回写完成后，应查看脚本报告里的“姓名字形不一致写入”“无资料名单”“未写入的审核结果 TXT”。这些信息用于最终人工复核，尤其是 Excel 姓名和资料姓名不完全一致的学生。

---

## 功能特性（务必阅读）

- 本地网页审核：左侧编辑 TXT 审核结果，右侧预览对应 PDF。
- 学校筛选：学生列表可按学校过滤，适合多学校同时审核。
- 自动保存：切换学生、上一个、下一个前会先保存当前审核结果。
- 快捷短语：支持小键盘 `1-5` 插入常见问题短语。
- 资料导入：网页内可导入新的 PDF 资料文件夹，自动创建缺失的审核结果 TXT。
- 审核准备脚本：自动读取 Excel 名单、创建 TXT、核对人名差异。
- 结果回写脚本：审核完成后批量写回 Excel，并标记缺资料人员。

## 为什么网页工具还配了一个 Skill ？

网页工具只负责审核过程中的交互：列出学生、预览 PDF、编辑并保存 `审核结果/<学校名>/<人名>_审核结果.txt`。它不适合承担“找 Excel、解析姓名列、批量创建审核结果、核对名单差异、写回 Excel”这些准备和收尾工作。

`league-review-prep` skill 是给 Codex 使用的操作规程和自动化脚本，负责把新学校资料整理成网页能直接读取的结构，并在审核完成后把 TXT 结果写回 Excel。

这个项目支持两种使用方式：

- 你可以人工运行 `prepare_school_review.py`，完全按脚本规则处理。
- 你也可以让 Codex 使用 `league-review-prep` skill，在自动化脚本之外借助 AI 的判断力处理真实材料里的不规则情况。

需要 AI 判断的不是核心写入规则，而是脚本运行前后的边界问题：哪个 Excel 才是名单、哪个文件夹才是 PDF 资料目录、报告中的姓名差异是否需要额外提醒、模糊匹配多候选时是否必须停下来让人确认。真正的批量创建、核对、模糊匹配、红字 `无资料` 和 Excel 回写，仍由脚本按固定规则执行。

这样做的好处是：

- 新学校接入时，Codex 可以按统一命令自动创建 `审核结果` 目录下的 TXT。
- Excel 名单和 PDF 文件名的缺漏、笔误会在审核前集中报告。
- 审核完成后，Codex 可以按同一套规则回写 Excel，缺资料者红字标记 `无资料`。
- 规则写在 skill 和脚本里，后续换学校时不用重新解释整套流程。

PDF 资料目录下不需要放同名 TXT。旧版本曾支持这种旁路草稿文件，现在已经改为只读写 `审核结果` 目录。

## 姓名匹配与笔误处理

本项目以 Excel 名单作为最终名册依据，但资料文件名和审核结果 TXT 可能存在录入笔误。

处理原则：

- 审核前核对时，只报告差异，不自动改 Excel。
- 审核网页匹配 PDF 时，会优先精确匹配；文件名包含关系可作为预览匹配依据。
- 审核结果回写 Excel 时，先用精确姓名匹配。
- 如果 Excel 姓名和 TXT 姓名同长度、同姓、只差 1 个字，且候选唯一，会自动视为高置信笔误并写入。例如示例里的 `李明 ← 李铭`。
- 所有姓名字形不一致都会在报告里列出；高置信自动写入也必须报告，方便人工复核。
- 如果一个 Excel 姓名同时接近多个 TXT 姓名，脚本不会猜测，会把该行标红 `无资料` 并报告候选，等待用户通过 `--alias` 指定。
- 资料里多出来但不在 Excel 名单中的审核结果，不会写入任何名单行，会在报告里列为“未写入的审核结果 TXT”。

这个策略的目标是避免两类错误：既不因为一个明显错字漏填，也不把不确定的人名写到错误学生身上。

---

## 目录说明

```text
review-web/                         # 本地审核网页
  server.js                         # Node HTTP 服务
  public/                           # 前端页面
  sources.json                      # 本地导入来源配置，可按需生成
codex-skills/
  league-review-prep/               # Codex skill：事前准备和事后回写
examples/                           # 虚构示例资源
审核结果/                            # TXT 审核结果根目录
注意事项.txt                         # 网页左侧审核注意事项
start-review.cmd                    # Windows 一键启动
start-review.ps1
```

---

## 面向开发者的维护说明

### Web 工具

`review-web/server.js` 使用 Node 内置 `http` 模块，不依赖 Express。它负责：

- 扫描 `审核结果` 下的 TXT
- 根据 `review-web/sources.json` 和工作区 PDF 建立匹配
- 提供 PDF 静态预览
- 提供 TXT 读取和保存接口
- 提供资料文件夹导入接口

前端在 `review-web/public`，主要状态在 `app.js`。注意保持切换学生前调用 `saveCurrentReview()`，避免用户录入丢失。

### Skill 脚本

`codex-skills/league-review-prep/scripts/prepare_school_review.py` 是可重复执行的核心脚本。

常用模式：

```powershell
# 审核前准备
python codex-skills/league-review-prep/scripts/prepare_school_review.py --school-dir "学校文件夹" --update-web-sources

# 审核后回写
python codex-skills/league-review-prep/scripts/prepare_school_review.py --school-dir "学校文件夹" --write-excel
```

维护时重点关注：

- `extract_name()`：文件名归一化规则
- `suspicious_pairs()`：审核前差异报告
- `find_confident_result_match()`：审核后高置信模糊回写
- `write_reviews_to_excel()`：Excel 写回与红字 `无资料`

### 隐私与开源边界

真实 PDF、真实 Excel 名单、真实审核结果 TXT 都不应提交到公开仓库。`.gitignore` 已默认排除这些类型，只保留 `examples/示例中学` 和示例 `审核结果`。

发布前建议执行：

```powershell
rg "真实学校名|真实学生名|身份证|联系电话" .
git status --short
```

确认没有真实资料进入提交。

---

## 许可证

Apache License 2.0

## 🔗 LinuxDo 社区

<div align="center">
  <a href="https://linux.do" target="_blank">
    <img src="https://cdn3.ldstatic.com/original/4X/c/c/d/ccd8c210609d498cbeb3d5201d4c259348447562.png" alt="LinuxDo" height="60">
  </a>
  <p>
    <a href="https://linux.do" target="_blank"><strong>LinuxDo 社区</strong></a><br>
  </p>
    <p>@蕉灼の仓鼠</p>
    <p>本人长期活跃于L站;</p>
    <p>这里的人很好说话又好听;</p>
    <p>欢迎都来加入L站大家庭。 </p>

</div>
