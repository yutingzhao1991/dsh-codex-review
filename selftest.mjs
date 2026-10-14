/**
 * 运行：node selftest.mjs
 * 假 ctx 自测：不起宿主进程，直接驱动插件模块，验证 job 输出环里装的是评审结论
 * 而不是 codex 的进度日志，以及就地返回 / 后台返回 / 失败 / 截断几条路径。
 */
import { writeFileSync, readFileSync } from 'node:fs';

const PLUGIN = new URL('./index.js', import.meta.url).href;

function makeHarness({ exitCode = 0, stdout = '', stderr = '', report = '', wait = 'settle', config = {} } = {}) {
	const state = { tool: undefined, jobs: new Map(), counter: 0, specs: [], waits: [] };
	const ctx = {
		tools: {
			register(definition) {
				state.tool = definition;
				return () => {
					state.tool = undefined;
				};
			},
		},
		effect(fn) {
			return fn();
		},
		subprocess: {
			async resolveExecutable(command) {
				if (command === 'codex') return '/fake/codex';
				if (command.startsWith('/')) return command;
				throw new Error('not found');
			},
			spawn(spec) {
				state.specs.push(spec);
				const index = spec.argv.indexOf('--output-last-message');
				if (index >= 0) writeFileSync(spec.argv[index + 1], report);
				const reader = (text) => ({ readFrom: () => ({ text, lossy: false, nextOffset: text.length, spillPath: `/spill/${text.length}` }) });
				return {
					collected: { stdout: reader(stdout), stderr: reader(stderr) },
					done: Promise.resolve({ exitCode, signal: null }),
					terminate() {},
				};
			},
		},
		jobs: {
			start(spec) {
				const id = `codex-review-${++state.counter}`;
				const record = { id, label: spec.label, chunks: [], status: 'running', detail: undefined, progress: undefined };
				const handle = {
					id,
					append(text, options) {
						record.chunks.push({ text, channel: options?.channel });
					},
					updateProgress(line) {
						record.progress = line;
					},
				};
				const hooks = spec.run(handle);
				record.hooks = hooks;
				record.settledPromise = hooks.done.then((outcome) => {
					record.status = outcome.status;
					record.detail = outcome.detail;
					return outcome;
				});
				state.jobs.set(id, record);
				return id;
			},
			async wait(id, timeoutMs) {
				state.waits.push(timeoutMs);
				const record = state.jobs.get(id);
				if (wait === 'running') return { status: 'running' };
				await record.settledPromise;
				return { status: record.status, ...(record.detail === undefined ? {} : { detail: record.detail }) };
			},
			read(id) {
				const record = state.jobs.get(id);
				return { chunks: record.chunks, lossy: false, job: { output: { spillPaths: [] } } };
			},
			remove(id) {
				state.jobs.delete(id);
			},
			kill(id, owner, reason) {
				state.jobs.get(id)?.hooks.cancel(reason);
			},
		},
	};
	const module = { ctx, state, config };
	return module;
}

async function loadPlugin(config) {
	const harness = makeHarness({ ...config.harness, config: config.plugin });
	const mod = await import(PLUGIN);
	mod.apply(harness.ctx, config.plugin ?? {});
	return { ...harness, definition: harness.state.tool, mod };
}

const exec = { agent: { session: { header: { cwd: '/tmp' } } }, signal: new AbortController().signal };

let failures = 0;
function check(name, condition, detail) {
	if (condition) {
		console.log(`  ok   ${name}`);
		return;
	}
	failures += 1;
	console.log(`  FAIL ${name}${detail === undefined ? '' : ` — ${detail}`}`);
}

// A. 就地返回：结论进结果，进度日志不进
{
	const noise = 'x'.repeat(200_000);
	const h = await loadPlugin({ harness: { stdout: noise, stderr: 'progress noise', report: '# 评审结论\n\n发现一个 P2 问题。' } });
	const value = await h.definition.execute({}, exec);
	check('A kind=completed', value.kind === 'completed', JSON.stringify(value).slice(0, 200));
	check('A 结论在结果里', value.report.includes('发现一个 P2 问题'));
	check('A 进度日志没进结果', !value.report.includes('progress noise') && value.report.length < 5_000, `len=${value.report.length}`);
	const ring = h.state.jobs.get('codex-review-1');
	check('A 环已随 remove 清掉', ring === undefined);
}

// B. 后台返回：先拿 job id，环里最终是结论
{
	const h = await loadPlugin({ harness: { wait: 'running', stderr: 'progress noise', report: '评审结论：没有发现问题。' } });
	const value = await h.definition.execute({}, exec);
	check('B kind=running', value.kind === 'running' && value.jobId === 'codex-review-1', JSON.stringify(value));
	const record = h.state.jobs.get('codex-review-1');
	await record.settledPromise;
	const ring = (record.chunks ?? []).map((chunk) => chunk.text).join('');
	check('B 环里是结论', ring.includes('没有发现问题'), ring.slice(0, 120));
	check('B 环里没有进度日志', !ring.includes('progress noise'), ring.slice(0, 120));
	check('B progress 行已设置', record.progress === 'reviewing');
}

// C. 失败：状态行 + codex 输出尾部
{
	const h = await loadPlugin({ harness: { exitCode: 1, stderr: 'stream error: not logged in', report: '' } });
	const value = await h.definition.execute({}, exec);
	check('C 状态行', value.report.includes('[codex review failed, exit code: 1]'), value.report);
	check('C 带上 stderr', value.report.includes('not logged in'), value.report);
}

// D. 参数校验与 argv 拼装
{
	const h = await loadPlugin({});
	for (const [name, args] of [
		['base+commit 互斥', { base: 'main', commit: 'abc' }],
		['范围开关与 instructions 互斥', { base: 'main', instructions: '只看并发' }],
		['commit 与 instructions 互斥', { commit: 'abc', instructions: '只看并发' }],
		['instructions 不能是 -', { instructions: '-' }],
		['base 含换行', { base: 'a\nb' }],
	]) {
		let threw = false;
		try {
			await h.definition.execute(args, exec);
		} catch {
			threw = true;
		}
		check(`D 拒绝 ${name}`, threw);
	}
	const baseArgv = await h.definition.execute({ base: 'main' }, exec).then(() => h.state.specs.at(-1).argv);
	check(
		'D argv 顺序（--base）',
		JSON.stringify(baseArgv.slice(0, 7)) === JSON.stringify(['/fake/codex', 'exec', 'review', '--base', 'main', '--ephemeral', '--output-last-message']),
		JSON.stringify(baseArgv.slice(0, 7)),
	);

	const plain = await loadPlugin({});
	await plain.definition.execute({}, exec);
	check('D 不带参数 → --uncommitted', plain.state.specs.at(-1).argv.includes('--uncommitted'), JSON.stringify(plain.state.specs.at(-1).argv));

	// 只给 instructions：不带任何范围开关，且用 `--` 终止符把以 `-` 开头的指令当值传。
	const focus = await loadPlugin({});
	const focusArgv = await focus.definition.execute({ instructions: '--focus on concurrency' }, exec).then(() => focus.state.specs.at(-1).argv);
	check('D 带指令时无范围开关', !focusArgv.some((value) => ['--uncommitted', '--base', '--commit'].includes(value)), JSON.stringify(focusArgv));
	check('D 指令前有 -- 终止符', focusArgv.at(-2) === '--' && focusArgv.at(-1) === '--focus on concurrency', JSON.stringify(focusArgv.slice(-3)));
}

// E. 超长报告：首尾截断 + 完整路径
{
	const h = await loadPlugin({ plugin: { maxResultChars: 100 }, harness: { report: `${'开头'.repeat(60)}${'中间'.repeat(60)}${'结尾'.repeat(60)}` } });
	const value = await h.definition.execute({}, exec);
	check('E 截断提示', value.report.includes('字符省略') && value.report.includes('完整报告：'), value.report.slice(0, 200));
	check('E 保留路径可读', (() => {
		const match = value.report.match(/完整报告：(.+?)\]/);
		return match !== null && readFileSync(match[1], 'utf8').length > 100;
	})());
}

// F. 配置：executable 绝对路径 / ephemeral=false / model
{
	const h = await loadPlugin({ plugin: { executable: '/opt/x/codex', ephemeral: false, model: 'gpt-x' }, harness: {} });
	await h.definition.execute({}, exec);
	const argv = h.state.specs.at(-1).argv;
	check('F executable 生效', argv[0] === '/opt/x/codex', argv[0]);
	check('F 无 --ephemeral', !argv.includes('--ephemeral'), JSON.stringify(argv));
	check('F model 生效', argv.includes('-m') && argv.includes('gpt-x'), JSON.stringify(argv));
}

// G. waitMs = 0：纯后台，不去碰注册表的等待（它对非正数时长直接抛错）
{
	const h = await loadPlugin({ plugin: { waitMs: 0 }, harness: { report: 'x' } });
	const value = await h.definition.execute({}, exec);
	check('G 直接交回 job id', value.kind === 'running' && value.jobId === 'codex-review-1', JSON.stringify(value));
	check('G 没有发起等待', h.state.waits.length === 0, JSON.stringify(h.state.waits));
}

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
