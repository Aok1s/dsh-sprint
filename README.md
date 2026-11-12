# dsh-sprint

考前速成整理，给 DeepSeek Harness（DSH）用的插件。

它不做题，管的是管道——内容还是模型写：

- **抽资料**：PDF 按页抽全文、按章切；PPTX 抽文字并导出内嵌图（公式基本都在图里）；网课截图按拍摄时间排序编号。
- **记状态**：每个科目一个 `sprint.json`，记住科目、考试日、章节范围、每一步的产出。
- **出 PDF**：`xelatex -no-pdf` 加 `xdvipdfmx` 两步编译，自动读日志报错，再把每页渲染成 PNG 供人眼复核。
- **自检**：交付前查日志里有没有 `^!`、产物是否为空、页数够不够。

五件套（精简教材 / A4 底稿 / 题目集 / 完整解答 / 速成讲义）照 `HANDOFF.md` 的 S0–S6 走。

## 安装

```bash
# 本地目录链接进 profile
dsh plugin --profile desktop add link:G:\workplace\study-kit
```

或者把仓库放进 profile 的依赖，并在 `dsh.profile.bundles` 里加 `dsh-sprint`。

## 快速开始

```text
sprint {"action":"project.init","payload_json":"{\"subject\":\"激光原理\"}"}
sprint {"action":"scan.pdf","payload_json":"{\"path\":\"书.pdf\",\"offset\":8,\"ranges\":[{\"name\":\"ch1\",\"from\":9,\"to\":26}]}"}
sprint {"action":"render.tex","payload_json":"{\"tex\":\"_work/main.tex\"}"}
sprint {"action":"render.preview","payload_json":"{\"pdf\":\"_work/main.pdf\"}"}
sprint {"action":"check.accept","payload_json":"{\"tex\":\"_work/main.tex\",\"minPages\":5}"}
```

对话里也可以 `/sprint init 激光原理`、`/sprint status`、`/sprint template`、`/sprint check xxx.pdf`。

## 动作

| action | 作用 | 主要参数 |
|---|---|---|
| `project.init` | 建 `_work/` 与 `sprint.json` | subject, exam, chapters, outDir |
| `project.status` | 看任务与产物 | — |
| `config.get` / `config.set` | 选择输出目录：中间件目录、交付目录、Python 路径 | outDir, deliverDir, python |
| `scan.pdf` | 抽全文并按章切 | path, offset, ranges |
| `scan.ppt` | 抽文字、导出图片 | path |
| `scan.shots` | 截图按时间排成 s01.png… | path |
| `render.tex` | 两步编译并报错 | tex, name |
| `render.preview` | 每页渲染 PNG | pdf, dpi |
| `check.accept` | 交付自检 | tex 或 pdf, minPages |
| `subject.create` | 建一个科目：books/questions/ppt/shots/_work/_out | name, exam |
| `subject.list` | 有哪些科目、各有几份资料 | — |
| `subject.remove` | 一键清理：`mode:work` 只清中间件，`mode:all` 整科删除（要 confirm） | name, mode, confirm |
| `split.pdf` | 大 PDF 切单页 + 按 ranges 合并成章节 | path, ranges, mode |
| `plan.coverage` / `plan.next` | 网课章节对照书章节，推荐下一节 | sections |
| `draft.new` / list / update / patch | 每节草稿的状态机，交截图后打补丁 | title, status, action |
| `subject.bootstrap` | 一次收资料：按扩展名把书/题/截图/PPT 归位，书自动抽一遍 | name, sourceDir |
| `sprint.status` | 一屏看全：计划/草稿/题目/口头提示的进度 | — |
| `book.set` | 记书本 PDF 与「PDF 页 = 书页 + offset」 | path, offset |
| `questions.parse` | 把「教材 P161 5.6 5.7」拆成可勾选的条目 | text, dryRun |
| `questions.import` / list / update | 登记成文件的题、勾状态 | path / items, id, status |
| `hint.add` / list / remove | 老师口头提示，单独成篇 hints.md | text, tag |
| `draft.claim` / release | 并发推进时先领租约（默认 1 小时） | id, owner, ttlSec |
| `parallel.plan` | 列出还没做完的小节，谁能领 | — |
| `template.install` | 复制排版模板 | name |
| `page.ocr` | 扫描件整本 OCR 成逐页文本（约 6 秒/页，可只跑一段） | pdf, from, to, dpi |
| `page.read` | 读某一页：有缓存用缓存，没有现场 OCR；`formulas:true` 同时出 LaTeX | page, pdf, formulas |
| `page.search` | 全文检索（扫 `_work/ocr`，439 页约 90 毫秒） | query, limit |

## 多科目分区

```text
G:\workplace\
├── 激光原理\                  ← 一个科目一个目录
│   ├── books/ questions/ ppt/ shots/   原始资料
│   ├── _work/                          中间件（扫描、切页、草稿、编译）
│   └── _out/                           交付件
├── 通信原理\
└── subjects.json              ← 科目登记表（插件写，别手改）
```

建科目之后，动作带上 `subject` 就落到那一科里：`{"action":"plan.coverage","payload_json":"{\"subject\":\"激光原理\", ...}"}`。

## 线性流程（他学他的，我生成我的）

```text
1. plan.coverage   把网课目录和书章节对上：必看 / 可跳 / 缺口，给出下一节
2. split.pdf       他看课的时候我把大 PDF 切页、按章合并
3. draft.new       给每一节建一条草稿：todo → drafting → needs-revision → ready
4. draft.patch     他交截图后 supplement / revise / approve，状态与历史都留在 drafts.json
```

## 并发推进（v2）

单会话是队列；要让两个执行者同时写不同章，用租约：

```text
1. parallel.plan              列出没做完的小节、哪一节现在能领
2. draft.claim  {id, owner}   领租约（默认 3600 秒），别人再 claim 会报错，force 可抢
3. draft.update / patch       写这一节
4. draft.release {id, owner}  还回去
```

租约只防「两个人同时写同一节」，不保证内容正确；内容仍然要 review 后 approve。

## 老师口头提示与题目清单

课上强调的一句话往往比整页 PPT 值钱，所以单独存、单独渲染：

```text
hint.add {"text":"P161 那两题解法要仔细推敲","tag":"重点"}   → 科目根目录 hints.md
```

有些作业不写在文件里，只是「教材 P161 的 5.6、5.7」这样一句话。questions.parse 把它拆成「哪一页、哪几题」，
配 book.set 记下的页偏移，就能换算出 PDF 页，清单落在 questions.md：

```text
book.set        {"path":"通信原理.pdf","offset":15}
questions.parse {"text":"教材 P161 5.6 5.7"}
```

题号写在页码下面几行也算；含汉字的行不会往下带页码（「附件作业 1-1 1-2」指的是另一个文件）。
重复跑不会重复登记，已登记的题跳过。hint.add / questions.update 都是一句话动作，学习途中随口记。

## 目录约定

```text
<项目>/
├── 书.pdf / PPT/ / 截图/        原始资料
├── _work/                       中间件（scan、render、out、shots、ocr、sprint.json）
└── 激光原理_1_精简教材.pdf        交付件，按序号放项目根
```

`config.set {outDir, deliverDir}` 可改这两条线，默认如上面。

## 结构

```text
index.js            工具与命令注册
lib/sprint.js       动作分发、状态、渲染、自检
lib/skills.js       注册 skills/exam-sprint
lib/py/*.py         PDF/PPT 抽取、PDF 转图、扫描件 OCR（pdfread.py / page_ocr.py）
skills/exam-sprint  S0–S6 流程说明
template.tex        排版模板（ctexart，色块标题/红字/蓝字/要点）
HANDOFF.md          方法论：口径、流程、工具链坑、验收清单
```

## 限制

- 抽取靠本机 Python（`pymupdf`、`python-pptx`），没有就自己装，插件不打包。
- 编译靠本机 LaTeX（`xelatex`、`xdvipdfmx`）；模板是 `ctexart`，要有中文字体。
- **退出码不可信**：本机实测会假报 127，判据只看 PDF 是否生成、日志里 `^!` 是否为 0。
- 切页后**单个文件**会小很多（276 页的书最大单页约 1.9 MB），但单页 PDF 各自带一份字体，全部加起来和省不了太多；只为减小总量就用 `mode:chapters` 只合并章节。
- 扫描件识别靠 `rapidocr_onnxruntime`（离线，12 MB 自带模型）；公式走 `texify`（torch CPU + 约 1 GB 模型，首次加载两分钟）。两个都不打包，要用再装。
- 行内公式（中文句子里夹着的）和多行 `cases` 公式转不了 LaTeX——那类只能读 OCR 文本、再看原图重建；独立成行的公式识别可靠（实测三条 3/3，还把文字层的 `S₂→Sz`、`0→O` 纠了回来）。
- Windows 上 Python 的 stdout 被管道接走时会退回 cp936，中文 JSON 到 node 侧变乱码；插件已统一设 `PYTHONIOENCODING=utf-8`。
- 不生成内容：知识网络、逐项释义、解法归范由模型写，插件只做管道。
- 不碰 StudyHub 的 `.dsh-study`。

## English

dsh-sprint is a DSH plugin for exam sprints: it extracts PDF/PPTX/lecture screenshots, keeps per-subject state, compiles LaTeX in the xelatex -no-pdf plus xdvipdfmx two-step, renders pages to PNG for visual review, and runs pre-delivery checks. Interface style (one tool with action plus payload_json) follows StudyHub, an MIT-licensed DSH plugin.

## License

MIT © Aok1s