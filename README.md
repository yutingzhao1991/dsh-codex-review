# dsh-codex-review

给 DSH 智能体一个 `codex_review` 工具：直接在本会话的工作目录里跑 `codex exec review`，
把评审结论回给它。零依赖的 Host 插件：只用 Node 内置模块，不需要 DSH 源码 checkout，按 profile 装。

## 为什么要有它

`codex exec review` 自己跑没问题，但让智能体通过 bash 工具跑会撞两堵墙：

1. **沙箱**：codex 需要读写 `~/.codex`（会话日志、sqlite、PATH 别名），在 DSH 文件沙箱下会
   报 `Operation not permitted`，评审还没开始就失败。
2. **命令审批**：`codex` 不在 `run_command` 的自动放行清单里，每次都要过一遍审批；审批关闭
   （`never`）时直接拒绝。

这个插件把进程直接交给 Host 侧的 `ctx.subprocess` 起，所以两者都不经过；同时把命令行钉死在
插件里，模型只能选「评审哪个范围」，没有注入别的开关的余地。

评审本身是只读的：**刻意不暴露** `--dangerously-bypass-approvals-and-sandbox` 这类开关，
codex 自己的沙箱与审批策略仍按用户 `~/.codex/config.toml` 走。

## 安装

clone 到你想长期保留的位置（profile 会**软链**到这个目录，别删也不用拷）：

```sh
git clone git@github.com:yutingzhao1991/dsh-codex-review.git ~/code/github/dsh-codex-review
```

然后二选一：

- 让智能体调 `plugin_manager` 的 `install_bundle`，`target` 传 clone 出来的**绝对路径**；
- 或命令行 `dsh plugin --profile web add ~/code/github/dsh-codex-review`（`web` 换成你的 profile 名；每个 profile 各装一次）。

新装的 bundle 立刻生效。**但改完 `index.js` 后必须重启宿主进程**：加载器用的是普通 `import()`，
同路径的模块被 ESM 缓存，而 profile 的 `hmr.root` 默认为空、并不监听这个目录——单靠启停 plugin
row 不会重新求值。升级同理：`git pull` 之后重启。

## 文件

| 文件 | 作用 |
| --- | --- |
| `index.js` | 插件本体（零依赖，只用 `node:` 内置模块） |
| `package.json` | bundle 清单，`dsh.bundle.patch` 指向 `cordis.patch.yml` |
| `cordis.patch.yml` | 把 Host 插件行插进 profile |
| `locale/{zh,en}.json` | 插件管理页上的展示名与说明 |
| `selftest.mjs` | 假 `ctx` 自测，见下文 |

## 工具怎么用

- `codex_review()` —— 评审 staged / unstaged / untracked 的全部改动（等价 `--uncommitted`）。
- `codex_review({ base: "main" })` —— 评审当前工作区相对该分支的改动。
- `codex_review({ commit: "<sha>" })` —— 评审该提交引入的改动。
- `codex_review({ instructions: "只看并发与错误处理" })` —— 带自定义评审指令。

`base` / `commit` 与 `instructions` **互斥**，这不是插件的取舍：codex CLI 自己声明 `[PROMPT]`
与 `--uncommitted`/`--base`/`--commit` 不能同时出现（实测报 `error: the argument '--commit
<SHA>' cannot be used with '[PROMPT]'`）。只给 `instructions` 时 codex 按**未提交的改动**评审
（实测它内部跑 `git status --short && git diff`），插件因此不带范围开关，并补一个 `--` 终止符，
让以 `-` 开头的指令（`--focus …`、列表式指令）也能当值传递。

评审要跑几分钟，所以执行走 `ctx.jobs` 后台注册表：等 `waitMs` 还没跑完就把 job id 交回去，
模型用现成的 `job_output` 收结论、`job_kill` 终止，结束时注册表会自动把完成通知发给发起会话。
跑完了就地返回，工具结果与 `job_output` 读出来的是**同一份文本**。

job 输出环里**只放评审结论**，不放 codex 的进度日志：后者会整段转储 diff 与 exec 输出
（实测一次评审十几万字节），让它进环等于每次读 job 都往上下文里灌一遍 diff。

## 可调项

在 profile 的 patch 层（`~/.dsh/profiles/<profile>/cordis.patch.yml`）按 id 覆盖，别改本目录的
`cordis.patch.yml`：

```yaml
- id: codex-review
  config:
    waitMs: 60000
```

覆盖是整块替换 `config`，没写的键用内置默认值。默认值都在 `index.js` 的 `DEFAULTS`：

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `executable` | `codex` | 可执行文件；解析顺序是它 → `codex` → `~/.local/bin/codex` → `/opt/homebrew/bin/codex` → `/usr/local/bin/codex` |
| `model` | 不设 | 传给 `codex -m`；不设就跟 `~/.codex/config.toml` |
| `ephemeral` | `true` | 传 `--ephemeral`，不把本次会话落盘到 `~/.codex/sessions` |
| `waitMs` | `120000` | 前台等待时长，超时交回 job id；`0` 表示不等待、直接交回 |
| `hardTimeoutMs` | `3600000` | 兜底墙钟上限；`0` 为不限制 |
| `maxResultChars` | `80000` | 结论回给模型的最大字符数，超出按首尾截断并给出完整报告路径 |
| `collectMaxBytes` | `262144` | codex 进度输出的保留字节数 |
| `spillMaxBytes` | `8388608` | 进度输出溢出落盘上限 |
| `envPassthrough` | `[]` | 额外透传的环境变量名（`subprocess` 默认抹掉 `KEY`/`PASSWORD`/`SECRET`/`TOKEN` 形状的名字） |

## 自测

`selftest.mjs` 用假 `ctx` 驱动插件本体，不需要起宿主进程，也不跑真的 codex：

```sh
node selftest.mjs
```

覆盖：就地返回与后台返回两条路径、结论不进进度日志、失败时带状态行与 stderr、参数校验、
argv 拼装、超长报告截断、可调项生效。

## 已知限制

- 工作目录固定为**会话工作目录**（`exec.agent.session.header.cwd`），不能指定别的仓库。
- 一次调用只能选一种评审范围（未提交 / base / commit），与 codex CLI 一致。
- 报告全文留在 `$TMPDIR/dsh-codex-review-*/report.md`；只有被截断时才会在结果里报出路径。
- **只在 codex 的受信任目录里能跑**：codex 对不在 `~/.codex/config.toml` 的 `[projects.*]`
  信任列表里的目录会拒绝（`Not inside a trusted directory`）。插件刻意不传
  `--skip-git-repo-check` —— 那是 codex 自己的信任闸，不该由这里代开。
