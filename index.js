/**
 * dsh-codex-review —— DSH Host 插件：给智能体一个 `codex_review` 工具。
 *
 * 直接在会话工作目录里跑 `codex exec review`，不经过 bash 工具，因此：
 *
 * - 不受 DSH 文件沙箱与命令审批影响。codex 需要读写 `~/.codex`（会话日志、
 *   PATH 别名、sqlite），在沙箱下会报 `Operation not permitted`；走审批又会让
 *   每次评审都卡在「要不要允许 codex」上。
 * - 命令行由插件拼装，模型只给「评审哪个范围」和「额外评审指令」，不必自己记
 *   `exec review --uncommitted --ephemeral` 这些参数，也没有注入别的开关的余地。
 *
 * 评审本身是只读的：这里刻意不暴露 `--dangerously-bypass-approvals-and-sandbox`
 * 之类的开关，codex 自己的沙箱与审批策略保持用户 `~/.codex/config.toml` 的配置。
 *
 * 执行放进 `ctx.jobs` 后台注册表（与 bash 后台命令同一套机制）：工具会等一小段
 * 时间，跑完就地返回评审结论，没跑完就交回 job id，之后由模型用 `job_output`
 * 收结果、`job_kill` 终止，结束时注册表会自动通知发起会话。
 */

import { statSync } from 'node:fs';
import { mkdtemp, readFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

/** 加载器诊断用的插件名。 */
export const name = 'codex-review';

/** 硬依赖：缺任何一个都说明这套组合跑不了这个工具，直接不激活而不是半残。 */
export const inject = ['tools', 'subprocess', 'jobs'];

/** 可调项默认值；`cordis.patch.yml` 里同名键覆盖。 */
const DEFAULTS = {
	/** `codex` 可执行文件：绝对路径或 PATH 里的名字。 */
	executable: 'codex',
	/** 传给 `codex -m` 的模型；不设就跟随用户 `~/.codex/config.toml`。 */
	model: undefined,
	/** 是否传 `--ephemeral`（不把本次会话落盘到 `~/.codex/sessions`）。 */
	ephemeral: true,
	/** 前台等待时长；超时把 job id 交给模型，不再阻塞。 */
	waitMs: 120_000,
	/** 兜底墙钟上限；`0` 表示不限制。 */
	hardTimeoutMs: 3_600_000,
	/** 评审正文回给模型的最大字符数，超出按首尾截断并给出完整报告路径。 */
	maxResultChars: 80_000,
	/** codex 进度输出的保留字节数。 */
	collectMaxBytes: 256 * 1024,
	/** 进度输出的兜底落盘上限（超出部分只保留尾部）。 */
	spillMaxBytes: 8 * 1024 * 1024,
	/** 额外透传给 codex 的环境变量名（凭据类变量会被 subprocess 服务默认抹掉）。 */
	envPassthrough: [],
};

const TOOL_DESCRIPTION = [
	'用 codex 评审代码改动，返回它的评审结论（findings、风险、建议）。',
	'',
	'不传参数时评审工作区里 staged / unstaged / untracked 的全部改动。',
	'',
	'评审通常要跑几分钟：等待超过插件等待时长会返回 job id，用 job_output 读取结果；跑完会自动通知。',
].join('\n');

/** 参数里没有必填项：不传就是评审未提交的改动。 */
const PARAMETERS = {
	type: 'object',
	additionalProperties: false,
	properties: {
		base: {
			type: 'string',
			description: '评审当前工作区相对该分支的改动（如 "main"）。与 commit、instructions 互斥。',
		},
		commit: {
			type: 'string',
			description: '评审该提交引入的改动（commit sha）。与 base、instructions 互斥。',
		},
		instructions: {
			type: 'string',
			description: '附加评审指令，用来聚焦关注点（如「只看并发与错误处理」）。与 base、commit 互斥；这时 codex 按未提交的改动评审。',
		},
	},
};

const OUTPUT_SCHEMA = {
	type: 'object',
	additionalProperties: false,
	properties: {
		kind: { type: 'string', enum: ['completed', 'running'] },
		jobId: { type: 'string' },
		status: { type: 'string' },
		detail: { type: 'string' },
		report: { type: 'string' },
	},
	required: ['kind', 'report'],
};

function isRecord(value) {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function messageOf(error) {
	return error instanceof Error ? error.message : String(error);
}

/** 归一化可调项：非法值退回默认，别让一次手写配置把插件打瘫。 */
function resolveSettings(config) {
	const raw = isRecord(config) ? config : {};
	const settings = { ...DEFAULTS };
	for (const key of ['executable', 'model']) {
		if (typeof raw[key] === 'string' && raw[key].trim().length > 0) settings[key] = raw[key].trim();
		else settings[key] = DEFAULTS[key];
	}
	if (typeof raw.ephemeral === 'boolean') settings.ephemeral = raw.ephemeral;
	for (const key of ['waitMs', 'hardTimeoutMs', 'maxResultChars', 'collectMaxBytes', 'spillMaxBytes']) {
		const value = raw[key];
		if (typeof value === 'number' && Number.isFinite(value) && value >= 0) settings[key] = Math.floor(value);
	}
	if (Array.isArray(raw.envPassthrough)) {
		settings.envPassthrough = raw.envPassthrough.filter((entry) => typeof entry === 'string' && entry.length > 0);
	}
	return settings;
}

/** 工具卡片标题与 job 标签：只做展示，任何输入都不抛。 */
function describeTarget(raw) {
	const args = isRecord(raw) ? raw : {};
	const base = typeof args.base === 'string' ? args.base.trim() : '';
	const commit = typeof args.commit === 'string' ? args.commit.trim() : '';
	const instructions = typeof args.instructions === 'string' ? args.instructions.trim() : '';
	if (base.length > 0) return `codex review --base ${base}`;
	if (commit.length > 0) return `codex review --commit ${commit}`;
	if (instructions.length > 0) return `codex review --uncommitted -- ${instructions.length > 60 ? `${instructions.slice(0, 60)}…` : instructions}`;
	return 'codex review --uncommitted';
}

/**
 * 校验模型参数。值只作为独立 argv 传递，不存在 shell 拼接；这里挡住的是无意义的形态。
 *
 * `base`/`commit` 与 `instructions` 互斥不是我们的选择：codex CLI 自己声明
 * `[PROMPT]` 不能与 `--uncommitted`/`--base`/`--commit` 同时出现，给了 PROMPT 它就按
 * 未提交的改动评审。与其静默丢掉一边，不如明确拒绝。
 */
function validateArgs(raw) {
	const args = isRecord(raw) ? raw : {};
	const base = typeof args.base === 'string' ? args.base.trim() : '';
	const commit = typeof args.commit === 'string' ? args.commit.trim() : '';
	const instructions = typeof args.instructions === 'string' ? args.instructions.trim() : '';
	if (base.length > 0 && commit.length > 0) {
		throw new Error('base 与 commit 只能给一个：base 评审相对分支的改动，commit 评审某个提交的改动。');
	}
	if (instructions.length > 0 && (base.length > 0 || commit.length > 0)) {
		throw new Error('base / commit 不能与 instructions 同时给：codex CLI 里自定义评审指令 [PROMPT] 与这三个范围开关互斥。要么只给范围（全量评审），要么只给 instructions（此时按未提交的改动评审）。');
	}
	for (const [label, value] of [['base', base], ['commit', commit]]) {
		if (value.length === 0) continue;
		if (value.length > 200 || /[\0\n\r]/.test(value)) throw new Error(`${label} 取值不合法（最多 200 字符，且不能含换行）。`);
	}
	if (instructions === '-') throw new Error('instructions 不能是 "-"（那是 codex 的「从 stdin 读」约定，本工具不提供 stdin）。');
	if (instructions.length > 8000) throw new Error('instructions 过长：最多 8000 字符。');
	return { base, commit, instructions };
}

function buildArgv(executable, target, reportPath, settings) {
	const argv = [executable, 'exec', 'review'];
	// 给了自定义指令就**不带**范围开关：CLI 层面两者互斥（[PROMPT] 与
	// --uncommitted/--base/--commit 同时出现会被判为非法组合），此时 codex 按未提交的改动评审。
	if (target.instructions.length === 0) {
		if (target.base.length > 0) argv.push('--base', target.base);
		else if (target.commit.length > 0) argv.push('--commit', target.commit);
		else argv.push('--uncommitted');
	}
	if (settings.ephemeral) argv.push('--ephemeral');
	if (typeof settings.model === 'string' && settings.model.length > 0) argv.push('-m', settings.model);
	// 评审结论走文件：进度日志可能很长，而结论不该跟着被截断。
	argv.push('--output-last-message', reportPath);
	// `--` 不能省：指令常以 `-` 或 `--` 开头（列表式指令、`--focus ...`），没有终止符时
	// CLI 会把它当成未知选项直接报错。codex 自己的报错提示也是让加 `--`。
	if (target.instructions.length > 0) argv.push('--', target.instructions);
	return argv;
}

/** 会话工作目录；拿不到就退回宿主进程 cwd。 */
function resolveCwd(exec) {
	const fromAgent = exec.agent?.session?.header?.cwd;
	if (typeof fromAgent === 'string' && fromAgent.length > 0) return fromAgent;
	return process.cwd();
}

function assertDirectory(path) {
	try {
		if (statSync(path).isDirectory()) return;
	} catch {
		/* 落到下面的统一报错 */
	}
	throw new Error(`工作目录不可用：${path}`);
}

function describeOutcome(outcome) {
	const parts = [`exit code: ${outcome.exitCode ?? 'none'}`];
	if (outcome.signal !== null && outcome.signal !== undefined) parts.push(`signal: ${outcome.signal}`);
	return parts.join(', ');
}

/**
 * codex 的 stdout/stderr 只用于诊断（失败时看它到底卡在哪），**不进 job 输出环**：
 * 进度日志会整段转储 diff 与 exec 输出，实测一次评审十几万字节，而模型读 job 得到的
 * 应该是评审结论本身。环里只放 composeReport 组好的那一份文本。
 */
function renderCollected(proc) {
	const read = (channel) => {
		try {
			return proc?.collected?.[channel]?.readFrom(0) ?? { text: '', lossy: false };
		} catch {
			return { text: '', lossy: false };
		}
	};
	const out = read('stdout');
	const err = read('stderr');
	const separator = out.text.length > 0 && !out.text.endsWith('\n') ? '\n' : '';
	let body = out.text + (err.text.length > 0 ? `${separator}[stderr]\n${err.text}` : '');
	if (out.lossy || err.lossy) {
		const files = [out.spillPath, err.spillPath].filter((path) => typeof path === 'string' && path.length > 0);
		body += `${body.length > 0 && !body.endsWith('\n') ? '\n' : ''}[部分输出被丢弃；完整输出：${files.length > 0 ? files.join(', ') : '(不可用)'}]`;
	}
	return body;
}

/** 读回 job 输出环里的分片（环里只有结论，所以这里就是结论正文）。 */
function renderRing(chunks, lossy, spillPaths) {
	let body = chunks.map((chunk) => chunk.text).join('');
	if (lossy || chunks.some((chunk) => chunk.gapBefore === true)) {
		const files = spillPaths.length > 0 ? spillPaths.join(', ') : '(不可用)';
		body += `${body.length > 0 && !body.endsWith('\n') ? '\n' : ''}[部分输出被丢弃；完整输出：${files}]`;
	}
	return body;
}

export function apply(ctx, config) {
	const settings = resolveSettings(config);

	/** 只透传用户点名的变量：subprocess 服务默认会抹掉 KEY/PASSWORD/SECRET/TOKEN 形状的名字。 */
	const launchEnv = () => {
		const env = {};
		for (const key of settings.envPassthrough) {
			const value = process.env[key];
			if (value !== undefined) env[key] = value;
		}
		return env;
	};

	/** codex 可执行文件解析结果（成功才缓存，失败下次重试）。 */
	let executablePromise;
	async function resolveExecutable() {
		if (executablePromise === undefined) {
			executablePromise = resolveExecutableOnce().catch((error) => {
				executablePromise = undefined;
				throw error;
			});
		}
		return executablePromise;
	}

	async function resolveExecutableOnce() {
		const env = launchEnv();
		const candidates = [
			settings.executable,
			'codex',
			join(homedir(), '.local', 'bin', 'codex'),
			'/opt/homebrew/bin/codex',
			'/usr/local/bin/codex',
		].filter((candidate) => typeof candidate === 'string' && candidate.length > 0);
		const tried = [];
		for (const candidate of candidates) {
			try {
				return await ctx.subprocess.resolveExecutable(candidate, env);
			} catch (error) {
				tried.push(`${candidate}（${messageOf(error)}）`);
			}
		}
		throw new Error(`找不到 codex 可执行文件。可在插件 config.executable 指定绝对路径。已尝试：${tried.join('；')}`);
	}

	/**
	 * 启动一次 codex 进程，把「同步 spawn 失败 / 退出事实 / 被取消」都收敛成一个 job 结果。
	 * `current()` 给结算时的诊断读取用（see {@link renderCollected}）。
	 */
	function startCodex(spec) {
		const controller = new AbortController();
		let proc;
		let timer;
		if (settings.hardTimeoutMs > 0) {
			timer = setTimeout(() => controller.abort(`超过 ${settings.hardTimeoutMs}ms 硬上限`), settings.hardTimeoutMs);
			timer.unref?.();
		}
		const clearTimer = () => {
			if (timer !== undefined) {
				clearTimeout(timer);
				timer = undefined;
			}
		};
		const abortReason = () => (typeof controller.signal.reason === 'string' && controller.signal.reason.length > 0 ? controller.signal.reason : undefined);
		const done = (async () => {
			try {
				proc = ctx.subprocess.spawn({ ...spec, signal: controller.signal });
			} catch (error) {
				clearTimer();
				return controller.signal.aborted ? { status: 'killed', ...(abortReason() === undefined ? {} : { detail: abortReason() }) } : { status: 'failed', detail: messageOf(error) };
			}
			try {
				const outcome = await proc.done;
				if (controller.signal.aborted) {
					const reason = abortReason();
					return { status: 'killed', ...(reason === undefined ? {} : { detail: reason }) };
				}
				return { status: outcome.exitCode === 0 ? 'completed' : 'failed', detail: describeOutcome(outcome) };
			} catch (error) {
				const reason = abortReason();
				return controller.signal.aborted ? { status: 'killed', ...(reason === undefined ? {} : { detail: reason }) } : { status: 'failed', detail: messageOf(error) };
			} finally {
				clearTimer();
			}
		})();
		return {
			current: () => proc,
			done,
			cancel: (reason) => {
				clearTimer();
				if (!controller.signal.aborted) controller.abort(typeof reason === 'string' && reason.length > 0 ? reason : 'cancelled');
				try {
					proc?.terminate();
				} catch {
					/* 已退出或停止失败都不该盖住取消本身 */
				}
			},
		};
	}

	/** 读回评审正文；超长按首尾截断并保留完整报告路径。 */
	async function readReport(path) {
		let text;
		try {
			text = await readFile(path, 'utf8');
		} catch {
			return { text: '', truncated: false };
		}
		const limit = settings.maxResultChars;
		if (limit <= 0 || text.length <= limit) return { text, truncated: false };
		const head = Math.floor(limit * 0.6);
		const tail = limit - head;
		const omitted = text.length - limit;
		return {
			text: `${text.slice(0, head)}\n\n[… 中间 ${omitted} 字符省略 …]\n\n${text.slice(-tail)}`,
			truncated: true,
		};
	}

	function composeReport({ status, detail, body, streams, reportPath, truncated }) {
		const sections = [];
		if (status !== 'completed') sections.push(`[codex review ${status}${detail === undefined ? '' : `, ${detail}`}]`);
		if (body.trim().length > 0) sections.push(body.trim());
		if (status !== 'completed' && streams.trim().length > 0 && body.trim() !== streams.trim()) sections.push(streams.trim());
		if (truncated) sections.push(`[报告已截断；完整报告：${reportPath}]`);
		if (sections.length === 0) sections.push('(codex 没有输出)');
		return sections.join('\n\n');
	}

	/** 一次评审的模型可见文本：结论优先，失败时附上 codex 的进度输出便于定位。 */
	async function composeResultText(outcome, running, reportPath) {
		const { text: body, truncated } = await readReport(reportPath);
		return composeReport({
			status: outcome.status,
			detail: outcome.detail,
			body,
			streams: renderCollected(running.current()),
			reportPath,
			truncated,
		});
	}

	/** 取消后把 job 收到终态，避免留下没人认领的记录。 */
	async function stopJob(jobId, owner, reason) {
		try {
			ctx.jobs.kill(jobId, owner, reason);
		} catch {
			/* 已经结束 */
		}
		try {
			await ctx.jobs.wait(jobId, 10_000, owner);
		} catch {
			/* 等不到也照样移除 */
		}
		try {
			ctx.jobs.remove(jobId, owner);
		} catch {
			/* 已被移除 */
		}
	}

	const dispose = ctx.tools.register({
		name: 'codex_review',
		description: TOOL_DESCRIPTION,
		parameters: PARAMETERS,
		output: {
			schema: OUTPUT_SCHEMA,
			render: (_args, value) => [{ type: 'text', text: typeof value.report === 'string' ? value.report : '' }],
		},
		presentCall: (args) => ({ card: 'terminal', title: describeTarget(args) }),
		async execute(rawArgs, exec) {
			const target = validateArgs(rawArgs);
			const executable = await resolveExecutable();
			const cwd = resolveCwd(exec);
			assertDirectory(cwd);
			const owner = exec.agent?.id;
			const label = describeTarget(target);
			const workdir = await mkdtemp(join(tmpdir(), 'dsh-codex-review-'));
			const reportPath = join(workdir, 'report.md');
			const spec = {
				argv: buildArgv(executable, target, reportPath, settings),
				cwd,
				env: launchEnv(),
				graceMs: 5_000,
				stdio: {
					stdin: 'ignore',
					stdout: { maxBytes: settings.collectMaxBytes, spill: { maxBytes: settings.spillMaxBytes } },
					stderr: { maxBytes: settings.collectMaxBytes, spill: { maxBytes: settings.spillMaxBytes } },
				},
			};

			/** `run` 同步赋值；结论在生产者结算前写进输出环。 */
			let running;
			const jobId = ctx.jobs.start({
				kind: 'codex-review',
				label,
				...(owner === undefined ? {} : { owner }),
				run: (job) => {
					running = startCodex(spec);
					job.updateProgress('reviewing');
					const done = running.done.then(async (outcome) => {
						const text = await composeResultText(outcome, running, reportPath).catch(() => undefined);
						if (typeof text === 'string' && text.length > 0) job.append(text, { channel: 'stdout' });
						return outcome;
					});
					return { done, cancel: running.cancel };
				},
			});

			const runningValue = (status) => ({
				kind: 'running',
				jobId,
				status,
				report: `codex review 仍在运行（job ${jobId}，${label}）。用 job_output 读取结果、job_kill 终止；跑完会自动通知。`,
			});

			// `waitMs <= 0` 是「纯后台」：注册表不接受非正数的等待时长，也不必等。
			if (settings.waitMs <= 0) return runningValue('running');

			let view;
			try {
				view = await ctx.jobs.wait(jobId, settings.waitMs, owner, exec.signal);
			} catch (error) {
				await stopJob(jobId, owner, 'tool call aborted');
				throw new Error(`codex review 已取消（${messageOf(error)}）。`);
			}

			if (view.status === 'running' || view.status === 'stopping') return runningValue(view.status);

			// 结论就是输出环里的那一份：后台路径（job_output）与就地返回走同一份文本，
			// 不会出现「工具结果」与「job 读出来」两套说法。
			const read = ctx.jobs.read(jobId, owner);
			ctx.jobs.remove(jobId, owner);
			const report = renderRing(read.chunks, read.lossy, read.job.output.spillPaths ?? []);
			return {
				kind: 'completed',
				status: view.status,
				...(view.detail === undefined ? {} : { detail: view.detail }),
				report: report.trim().length > 0 ? report.trim() : '(codex 没有输出)',
			};
		},
	});

	ctx.effect(() => dispose);
}
