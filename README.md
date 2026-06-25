# 入团申请材料审核助手

这是一个本地运行的入团申请材料审核工具。它把“名单 Excel、PDF 资料、TXT 审核结果”组织成统一目录结构，在网页里左侧录入审核结果、右侧预览 PDF，并提供一个 Codex skill 用于新增学校前的准备和审核完成后的结果回写。

项目默认只在本机运行，不需要上传学生材料到第三方服务。

## 快速上手

### 1. 准备环境

需要安装：

- Node.js 18 或更高版本
- Python 3.10 或更高版本
- Python 依赖：`openpyxl`

如果需要生成或修改示例资源，可额外安装 `reportlab`；日常使用不需要。

### 2. 启动网页审核工具

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

仓库内置了完全虚构的示例：

```text
examples/
  示例中学/
    示例中学团员名单.xlsx
    入团申请资料/
      赵一诺.pdf
      赵一诺.txt
      李铭.pdf
      李铭.txt
      王小雨.pdf
      王小雨.txt
审核结果/
  示例中学/
    赵一诺_审核结果.txt
    李铭_审核结果.txt
    王小雨_审核结果.txt
```

示例中故意设置了一个姓名笔误：Excel 里是 `李明`，资料文件是 `李铭`。这用于演示高置信模糊匹配和回写规则。

### 4. 新增真实学校

把学校资料放在工作区内，例如：

```text
某某中学/
  某某中学团员名单.xlsx
  入团申请资料/
    张三.pdf
    李四.pdf
```

然后运行准备脚本：

```powershell
python codex-skills/league-review-prep/scripts/prepare_school_review.py --school-dir "某某中学" --make-sidecars --update-web-sources
```

脚本会：

- 自动寻找 Excel 中的 `姓名` 列
- 自动寻找 PDF 最多的资料目录
- 按 PDF 文件名创建 `审核结果/<学校名>/<人名>_审核结果.txt`
- 可选创建 PDF 同名空 TXT，方便资料目录自带审核草稿
- 报告“只在名单出现”“只在资料出现”“疑似姓名字形不一致”
- 更新 `review-web/sources.json`，让网页工具能直接导入该学校

### 5. 审核完成后回写 Excel

当某个学校的 TXT 审核结果都填完后，运行：

```powershell
python codex-skills/league-review-prep/scripts/prepare_school_review.py --school-dir "某某中学" --write-excel
```

脚本会把 `审核结果/<学校名>/*_审核结果.txt` 写入该校 Excel 的 `入团志愿书问题备注` 列。没有对应资料或审核结果的名单行，会用红色字写 `无资料`。

如果出现脚本无法确信的姓名对应关系，可显式指定：

```powershell
python codex-skills/league-review-prep/scripts/prepare_school_review.py --school-dir "某某中学" --write-excel --alias "Excel姓名=审核结果姓名"
```

## 功能特性

- 本地网页审核：左侧编辑 TXT 审核结果，右侧预览对应 PDF。
- 学校筛选：学生列表可按学校过滤，适合多学校同时审核。
- 自动保存：切换学生、上一个、下一个前会先保存当前审核结果。
- 快捷短语：支持小键盘 `1-5` 插入常见问题短语。
- 资料导入：网页内可导入新的 PDF 资料文件夹，自动创建缺失的审核结果 TXT。
- 审核准备脚本：自动读取 Excel 名单、创建 TXT、核对人名差异。
- 结果回写脚本：审核完成后批量写回 Excel，并标记缺资料人员。

## 姓名匹配与笔误处理

本项目以 Excel 名单作为最终名册依据，但资料文件名和审核结果 TXT 可能存在录入笔误。

处理原则：

- 审核前核对时，只报告差异，不自动改 Excel。
- 审核网页匹配 PDF 时，会优先精确匹配；文件名包含关系可作为预览匹配依据。
- 审核结果回写 Excel 时，先用精确姓名匹配。
- 如果 Excel 姓名和 TXT 姓名同长度、同姓、只差 1 个字，且候选唯一，会自动视为高置信笔误并写入。例如示例里的 `李明 ← 李铭`。
- 如果一个 Excel 姓名同时接近多个 TXT 姓名，脚本不会猜测，会把该行标红 `无资料` 并报告候选，等待用户通过 `--alias` 指定。
- 资料里多出来但不在 Excel 名单中的审核结果，不会写入任何名单行，会在报告里列为“未写入的审核结果 TXT”。

这个策略的目标是避免两类错误：既不因为一个明显错字漏填，也不把不确定的人名写到错误学生身上。

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
python codex-skills/league-review-prep/scripts/prepare_school_review.py --school-dir "学校文件夹" --make-sidecars --update-web-sources

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

## 许可证

MIT License。可按需要自行替换。
