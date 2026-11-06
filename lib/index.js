/**
 * dsh-comfyui-supervisor — host half.
 *
 * Gives the agent three tools to manage a local ComfyUI server's lifecycle:
 *   comfyui_status / comfyui_start / comfyui_stop
 *
 * Design notes:
 *   - No network calls and no process spawn at load time; DSH cold start is untouched.
 *   - Starting ComfyUI is delegated to the bundled `assets/supervise.cjs` (dependency-free node),
 *     which also enforces the idle-exit timeout. The plugin only probes and waits.
 *   - No `@deepseek-ai/*` imports: plugin packages are installed as links and would fail to
 *     resolve host packages from their physical path.
 */
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Plugin id (also the default loader entry id). */
export const name = 'dsh-comfyui-supervisor';
/** Required host service. */
export const inject = ['tools'];

const DEFAULTS = {
    baseUrl: 'http://127.0.0.1:8188',
    comfyRoot: 'D:\\ComfyUI',
    idleTimeoutMinutes: 30,
    startTimeoutSeconds: 300
};

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SUPERVISE_SCRIPT = path.join(HERE, '..', 'assets', 'supervise.cjs');

function pickString(value, fallback) {
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback;
}

function pickNumber(value, fallback, min, max) {
    const n = typeof value === 'number' && Number.isFinite(value) ? value : Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
}

/** Normalize the plugin config; every field is optional. */
export function normalizeConfig(raw) {
    const src = raw && typeof raw === 'object' ? raw : {};
    return {
        baseUrl: pickString(src.baseUrl, DEFAULTS.baseUrl).replace(/\/+$/, ''),
        comfyRoot: pickString(src.comfyRoot, DEFAULTS.comfyRoot),
        idleTimeoutMinutes: Math.round(pickNumber(src.idleTimeoutMinutes, DEFAULTS.idleTimeoutMinutes, 1, 24 * 60)),
        startTimeoutSeconds: Math.round(pickNumber(src.startTimeoutSeconds, DEFAULTS.startTimeoutSeconds, 30, 3600))
    };
}

function portOf(baseUrl, fallback = '8188') {
    try {
        const parsed = new URL(baseUrl);
        return parsed.port !== '' ? parsed.port : fallback;
    }
    catch {
        return fallback;
    }
}

/** Probe ComfyUI's cheap health endpoint. */
async function probe(baseUrl, timeout = 2500) {
    try {
        const res = await fetch(baseUrl + '/system_stats', { signal: AbortSignal.timeout(timeout) });
        return res.ok;
    }
    catch {
        return false;
    }
}

/** Fetch /system_stats and project the fields worth reporting. */
async function readStats(baseUrl) {
    try {
        const res = await fetch(baseUrl + '/system_stats', { signal: AbortSignal.timeout(4000) });
        if (!res.ok) return null;
        const body = await res.json();
        const device = Array.isArray(body?.devices) ? body.devices[0] : undefined;
        return {
            device: typeof device?.name === 'string' ? device.name : null,
            vramTotalMb: Number.isFinite(device?.vram_total) ? Math.round(device.vram_total / 1024 / 1024) : null,
            vramFreeMb: Number.isFinite(device?.vram_free) ? Math.round(device.vram_free / 1024 / 1024) : null,
            comfyVersion: typeof body?.system?.comfyui_version === 'string' ? body.system.comfyui_version : null
        };
    }
    catch {
        return null;
    }
}

function readJsonFile(file) {
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    }
    catch {
        return null;
    }
}

/** Managed-state file written by supervise.cjs. */
function readState(comfyRoot) {
    return readJsonFile(path.join(comfyRoot, '.supervisor.state'));
}

/** Single-instance lock written by supervise.cjs. */
function readLock(comfyRoot) {
    return readJsonFile(path.join(comfyRoot, '.supervisor.lock'));
}

function pidAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
        process.kill(pid, 0);
        return true;
    }
    catch {
        return false;
    }
}

function killTree(pid) {
    try {
        execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true, timeout: 15000 });
        return true;
    }
    catch {
        return false;
    }
}

/** Last resort for `comfyui_stop force`: whatever listens on the port. */
function findPidOnPort(port) {
    try {
        const out = execFileSync('netstat', ['-ano'], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
        for (const line of out.split(/\r?\n/)) {
            if (!line.includes('LISTENING')) continue;
            const cells = line.trim().split(/\s+/);
            if (cells.length < 5) continue;
            if (!cells[1].endsWith(':' + port)) continue;
            const pid = Number(cells[cells.length - 1]);
            if (Number.isInteger(pid) && pid > 0) return pid;
        }
    }
    catch {
        /* netstat missing or blocked */
    }
    return null;
}

function spawnSupervisor(config) {
    const port = portOf(config.baseUrl);
    const child = spawn(process.execPath, [
        SUPERVISE_SCRIPT,
        '--root', config.comfyRoot,
        '--port', port,
        '--idle-min', String(config.idleTimeoutMinutes),
        '--start-timeout', String(config.startTimeoutSeconds)
    ], { detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
    return child.pid;
}

const sleep = (ms, signal) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
        if (signal) signal.removeEventListener('abort', onAbort);
        resolve();
    }, ms);
    function onAbort() {
        clearTimeout(timer);
        reject(new Error('aborted'));
    }
    if (signal?.aborted) return onAbort();
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
});

async function waitReady(baseUrl, timeoutMs, signal) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (await probe(baseUrl)) return true;
        if (signal?.aborted) throw new Error('aborted');
        await sleep(2000, signal);
    }
    return false;
}

function line(label, value) {
    return value === null || value === undefined || value === '' ? null : `${label}：${value}`;
}

const OUTPUT_SCHEMA = {
    type: 'object',
    properties: {
        text: { type: 'string', description: '给人/模型看的完整结果说明' },
        running: { type: 'boolean', description: 'ComfyUI 当前是否可访问' },
        url: { type: 'string', description: 'ComfyUI 地址' },
        device: { type: 'string', description: '设备名（不可用时为空串）' },
        managed: { type: 'boolean', description: '是否是本插件守护启动的实例' },
        changed: { type: 'boolean', description: '本次调用是否改变了运行状态' }
    },
    required: ['text', 'running', 'url', 'device', 'managed', 'changed'],
    additionalProperties: false
};

function makeOutput(text, fields) {
    return {
        text,
        running: Boolean(fields.running),
        url: fields.url,
        device: fields.device ?? '',
        managed: Boolean(fields.managed),
        changed: Boolean(fields.changed)
    };
}

/**
 * Build the tool set. Exported so it can be unit-tested without booting DSH.
 * @param pluginConfig - the entry's `config` object from cordis.patch.yml.
 */
export function createTools(pluginConfig) {
    const config = normalizeConfig(pluginConfig);

    const statusTool = {
        name: 'comfyui_status',
        description: [
            '查看本地 ComfyUI 服务是否在运行、设备是什么、是不是由本插件守护启动的实例。',
            '只读操作，不会启动或停止任何东西。',
            '返回：是否运行、地址、设备名、显存、ComfyUI 版本、是否托管、空闲退出分钟数。'
        ].join('\n'),
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        output: { schema: OUTPUT_SCHEMA, render: (_args, value) => [{ type: 'text', text: String(value?.text ?? '') }] },
        async execute() {
            const running = await probe(config.baseUrl);
            const stats = running ? await readStats(config.baseUrl) : null;
            const state = readState(config.comfyRoot);
            const managed = Boolean(state && pidAlive(state.comfyPid));
            const lines = [
                running ? 'ComfyUI 正在运行。' : 'ComfyUI 没有在运行。',
                line('地址', config.baseUrl),
                line('设备', stats?.device),
                stats?.vramFreeMb != null && stats?.vramTotalMb != null ? `显存：空闲 ${stats.vramFreeMb} MB / 共 ${stats.vramTotalMb} MB` : null,
                line('ComfyUI 版本', stats?.comfyVersion),
                managed ? '实例由本插件守护（空闲 ' + config.idleTimeoutMinutes + ' 分钟会自动退出）。' : null
            ].filter(Boolean);
            return makeOutput(lines.join('\n'), { running, url: config.baseUrl, device: stats?.device, managed, changed: false });
        }
    };

    const startTool = {
        name: 'comfyui_start',
        description: [
            '确保本地 ComfyUI 在运行：已经在跑就直接返回；没在跑就拉起后台守护（懒启动）并等它就绪。',
            '守护会在一段时间没有生成活动后自动退出，不需要手动收尾。',
            '典型用途：在任何依赖 ComfyUI 的生图工具调用之前先执行一次。'
        ].join('\n'),
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        output: { schema: OUTPUT_SCHEMA, render: (_args, value) => [{ type: 'text', text: String(value?.text ?? '') }] },
        async execute(_args, exec) {
            const signal = exec?.signal;
            if (await probe(config.baseUrl)) {
                const stats = await readStats(config.baseUrl);
                const state = readState(config.comfyRoot);
                return makeOutput(
                    ['ComfyUI 已经在运行，无需启动。', line('地址', config.baseUrl), line('设备', stats?.device)].filter(Boolean).join('\n'),
                    { running: true, url: config.baseUrl, device: stats?.device, managed: Boolean(state && pidAlive(state.comfyPid)), changed: false }
                );
            }
            if (!fs.existsSync(SUPERVISE_SCRIPT)) {
                throw new Error('守护脚本缺失：' + SUPERVISE_SCRIPT + '（插件安装不完整，请重装 dsh-comfyui-supervisor）。');
            }
            const lock = readLock(config.comfyRoot);
            const supervisorPid = lock && pidAlive(lock.pid) ? lock.pid : spawnSupervisor(config);
            const timeoutMs = config.startTimeoutSeconds * 1000;
            let ready = false;
            try {
                ready = await waitReady(config.baseUrl, timeoutMs, signal);
            }
            catch {
                throw new Error('等待 ComfyUI 就绪时被取消。');
            }
            if (!ready) {
                throw new Error(
                    'ComfyUI 在 ' + config.startTimeoutSeconds + ' 秒内没有就绪。\n' +
                    '排查：1) 确认 ' + config.comfyRoot + '\\ComfyUI_windows_portable 完整；' +
                    '2) 看 ' + config.comfyRoot + '\\logs\\comfyui-*.log 的最后几行；' +
                    '3) 确认 ' + config.baseUrl + ' 端口没有被别的程序占用。'
                );
            }
            const stats = await readStats(config.baseUrl);
            return makeOutput(
                ['ComfyUI 已启动并可用（由本插件守护）。', line('地址', config.baseUrl), line('设备', stats?.device),
                    '空闲 ' + config.idleTimeoutMinutes + ' 分钟后会自动退出。'].filter(Boolean).join('\n'),
                { running: true, url: config.baseUrl, device: stats?.device, managed: true, changed: true }
            );
        }
    };

    const stopTool = {
        name: 'comfyui_stop',
        description: [
            '停止本地 ComfyUI，释放内存和显存。',
            '默认只停「本插件守护启动」的实例；如果 ComfyUI 是你手动启动的，需要显式传 force=true 才会强制停止。',
            '典型用途：机器要跑别的重负载任务前主动腾出资源。'
        ].join('\n'),
        parameters: {
            type: 'object',
            properties: {
                force: {
                    type: 'boolean',
                    description: '为 true 时，即使不是本插件守护的实例也强制停止（会按端口找到进程）。默认 false。'
                }
            },
            additionalProperties: false
        },
        output: { schema: OUTPUT_SCHEMA, render: (_args, value) => [{ type: 'text', text: String(value?.text ?? '') }] },
        async execute(args) {
            const force = args?.force === true;
            const state = readState(config.comfyRoot);
            const running = await probe(config.baseUrl);

            if (!running) {
                return makeOutput('ComfyUI 本来就没有在运行，无需停止。', { running: false, url: config.baseUrl, device: null, managed: false, changed: false });
            }

            if (state && Number.isInteger(state.comfyPid)) {
                killTree(state.comfyPid);
                if (Number.isInteger(state.supervisorPid)) killTree(state.supervisorPid);
                await sleep(2000).catch(() => {});
                const stillRunning = await probe(config.baseUrl);
                return makeOutput(
                    stillRunning ? '已发送停止指令，但 ComfyUI 仍在响应；请稍后再查一次 comfyui_status。' : 'ComfyUI 已停止，内存/显存已释放。',
                    { running: stillRunning, url: config.baseUrl, device: null, managed: true, changed: !stillRunning }
                );
            }

            if (!force) {
                return makeOutput(
                    'ComfyUI 正在运行，但不是本插件守护启动的实例，未做任何操作。\n' +
                    '如果你确实想停止它，调用 comfyui_stop 并传 force=true。',
                    { running: true, url: config.baseUrl, device: null, managed: false, changed: false }
                );
            }

            const pid = findPidOnPort(portOf(config.baseUrl));
            if (!pid) {
                return makeOutput('没能从端口找到 ComfyUI 进程，未做任何操作。', { running: true, url: config.baseUrl, device: null, managed: false, changed: false });
            }
            killTree(pid);
            await sleep(2000).catch(() => {});
            const stillRunning = await probe(config.baseUrl);
            return makeOutput(
                stillRunning ? '已强制结束进程，但端口仍在响应；可能有第二个实例。' : 'ComfyUI 已强制停止。',
                { running: stillRunning, url: config.baseUrl, device: null, managed: true, changed: !stillRunning }
            );
        }
    };

    return { config, tools: [statusTool, startTool, stopTool] };
}

/** Resolve the host tool registry defensively. */
function getToolRegistry(ctx) {
    const candidates = [];
    if (typeof ctx.reflect?.get === 'function') {
        candidates.push(ctx.reflect.get('tools', false));
        candidates.push(ctx.reflect.get('tools'));
    }
    if (typeof ctx.get === 'function') candidates.push(ctx.get('tools'));
    for (const candidate of candidates) {
        if (candidate && typeof candidate.register === 'function') return candidate;
    }
    return undefined;
}

/**
 * Plugin entry. Registers the three tools; never starts ComfyUI here.
 * @param ctx - host context
 * @param config - entry config from cordis.patch.yml
 */
export function apply(ctx, config) {
    const tools = getToolRegistry(ctx);
    if (!tools) {
        console.warn('[dsh-comfyui-supervisor] tools 服务不可用，未注册生命周期工具。');
        return;
    }
    const built = createTools(config);
    for (const tool of built.tools) tools.register(tool);
}
