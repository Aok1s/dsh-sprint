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
| `template.install` | 复制排版模板 | name |

## 目录约定

```text
<项目>/
├── 书.pdf / PPT/ / 截图/        原始资料
├── _work/                       中间件（scan、render、out、shots、sprint.json）
└── 激光原理_1_精简教材.pdf        交付件，按序号放项目根
```

`config.set {outDir, deliverDir}` 可改这两条线，默认如上面。

## 结构

```text
index.js            工具与命令注册
lib/sprint.js       动作分发、状态、渲染、自检
lib/skills.js       注册 skills/exam-sprint
lib/py/*.py         PDF/PPT 抽取、PDF 转图
skills/exam-sprint  S0–S6 流程说明
template.tex        排版模板（ctexart，色块标题/红字/蓝字/要点）
HANDOFF.md          方法论：口径、流程、工具链坑、验收清单
```

## 限制

- 抽取靠本机 Python（`pymupdf`、`python-pptx`），没有就自己装，插件不打包。
- 编译靠本机 LaTeX（`xelatex`、`xdvipdfmx`）；模板是 `ctexart`，要有中文字体。
- **退出码不可信**：本机实测会假报 127，判据只看 PDF 是否生成、日志里 `^!` 是否为 0。
- 不生成内容：知识网络、逐项释义、解法归范由模型写，插件只做管道。
- 不碰 StudyHub 的 `.dsh-study`。

## English

dsh-sprint is a DSH plugin for exam sprints: it extracts PDF/PPTX/lecture screenshots, keeps per-subject state, compiles LaTeX in the xelatex -no-pdf plus xdvipdfmx two-step, renders pages to PNG for visual review, and runs pre-delivery checks. Interface style (one tool with action plus payload_json) follows StudyHub, an MIT-licensed DSH plugin.

## License

MIT © Aok1s