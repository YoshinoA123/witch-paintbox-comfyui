import { ImageResponseError, readImageResponse } from './image-response.js';
import { queueImageGeneration } from './image-queue.js';
import { buildComfyPrompt, describeComfyWorkflow, ComfyWorkflowError } from './comfyui-workflow.js';
export const COMFY_DEFAULT_URL = 'http://127.0.0.1:8188';
/** 常用的 ComfyUI 采样器名称，仅作输入提示；用户可以手动填任何服务端有的名字。 */
export const COMFY_SAMPLERS = [
    'euler', 'euler_ancestral', 'heun', 'heunpp2', 'dpm_2', 'dpm_2_ancestral', 'lms', 'dpm_fast', 'dpm_adaptive',
    'dpmpp_2s_ancestral', 'dpmpp_sde', 'dpmpp_sde_gpu', 'dpmpp_2m', 'dpmpp_2m_sde', 'dpmpp_2m_sde_gpu',
    'dpmpp_3m_sde', 'dpmpp_3m_sde_gpu', 'ddpm', 'lcm', 'ipndm', 'ipndm_v', 'deis', 'res_multistep', 'uni_pc',
];
export const COMFY_SCHEDULERS = [
    'normal', 'karras', 'exponential', 'sgm_uniform', 'simple', 'ddim_uniform', 'beta', 'linear_quadratic', 'kl_optimal',
];
export function defaultComfyImageParameters() {
    return { steps: 28, cfg: 7, sampler: '', scheduler: '', width: 832, height: 1216, batch: 1, seed: -1, outputNode: '' };
}
export function defaultComfyWorkflowSettings() {
    return { workflow: '', timeoutSeconds: 300, pollMs: 1000 };
}
function fail(message, fault) {
    throw new ImageResponseError(message, fault);
}
function within(value, min, max, integer = false) {
    return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max && (!integer || Number.isInteger(value));
}
export function validateComfyImageParameters(value, invalid) {
    const source = (value ?? {});
    const steps = source.steps, cfg = source.cfg, width = source.width, height = source.height;
    const batch = source.batch, seed = source.seed, sampler = source.sampler, scheduler = source.scheduler, outputNode = source.outputNode;
    if (!within(steps, 1, 10_000, true) || !within(cfg, 0, 100)
        || !within(width, 64, 4096, true) || !within(height, 64, 4096, true)
        || !within(batch, 1, 16, true) || !within(seed, -1, 4_294_967_295, true)
        || typeof sampler !== 'string' || sampler.length > 128
        || typeof scheduler !== 'string' || scheduler.length > 128
        || typeof outputNode !== 'string' || outputNode.length > 64)
        invalid();
    return { steps, cfg, width, height, batch, seed, sampler, scheduler, outputNode };
}
export function validateComfyWorkflowSettings(value, invalid) {
    const source = (value ?? {});
    const workflow = source.workflow, timeoutSeconds = source.timeoutSeconds, pollMs = source.pollMs;
    if (typeof workflow !== 'string' || workflow.length > 512 * 1024)
        invalid();
    if (!within(timeoutSeconds, 10, 3600, true) || !within(pollMs, 250, 10_000, true))
        invalid();
    return { workflow, timeoutSeconds, pollMs };
}
/** ComfyUI 不校验密钥，但允许为空；只要 URL 合法即可。 */
export function validateComfyConnection(connection) {
    const url = typeof connection?.url === 'string' ? connection.url.trim().replace(/\/+$/, '') : '';
    if (!url)
        fail('请填写 ComfyUI 的服务地址，例如 http://127.0.0.1:8188。', 'setup');
    let endpoint;
    try {
        endpoint = new URL(url);
    }
    catch {
        return fail('请输入完整的 ComfyUI 地址，包含 http:// 或 https://。', 'setup');
    }
    if (!['https:', 'http:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.hash) {
        fail('ComfyUI 地址仅支持 HTTP 或 HTTPS，且不能包含账号、密码或 # 片段。', 'setup');
    }
    const key = typeof connection.key === 'string' ? connection.key.trim().replace(/^Bearer\s+/i, '') : '';
    if (key && /[^\x21-\x7e]/.test(key))
        fail('访问令牌只能包含可见 ASCII 字符。', 'setup');
    return { channel: 'custom', url, key, appendSuffix: false };
}
function baseOf(connection) {
    return connection.url.replace(/\/+$/, '');
}
function headers(connection, contentType) {
    const result = {};
    if (contentType)
        result['Content-Type'] = contentType;
    if (connection.key)
        result.Authorization = `Bearer ${connection.key}`;
    return result;
}
function requestInit(connection, contentType) {
    return { mode: 'cors', credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer', headers: headers(connection, contentType) };
}
function newClientId() {
    // crypto.randomUUID 需要安全上下文；局域网 http 访问时只有 getRandomValues 一定可用。
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
function abortError() {
    const error = new ImageResponseError('本次生图已取消。');
    error.name = 'AbortError';
    return error;
}
function sleep(ms, signal) {
    return new Promise((resolve, reject) => {
        if (signal.aborted) {
            reject(abortError());
            return;
        }
        const timer = setTimeout(() => { signal.removeEventListener('abort', cancel); resolve(); }, ms);
        function cancel() { clearTimeout(timer); reject(abortError()); }
        signal.addEventListener('abort', cancel, { once: true });
    });
}
async function readJson(response) {
    const text = await response.text();
    if (!text.trim())
        return {};
    try {
        return JSON.parse(text);
    }
    catch {
        return {};
    }
}
/** 连接测试：读 /system_stats，顺便确认这是不是一台 ComfyUI。 */
export async function testComfyConnection(connection, signal) {
    const configured = validateComfyConnection(connection);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    const relay = () => controller.abort();
    signal?.addEventListener('abort', relay, { once: true });
    try {
        const response = await fetch(`${baseOf(configured)}/system_stats`, { ...requestInit(configured), signal: controller.signal });
        if (!response.ok)
            fail(`连接失败（HTTP ${response.status}），请确认地址指向 ComfyUI 本体而不是登录页。`, 'network');
        const payload = await readJson(response);
        const record = (payload ?? {});
        const system = (record.system ?? {});
        const devices = Array.isArray(record.devices) ? record.devices : [];
        const version = typeof system.comfyui_version === 'string' ? system.comfyui_version : '';
        const device = devices[0];
        const gpu = device && typeof device.name === 'string' ? device.name : '';
        const vram = device && typeof device.vram_total === 'number' ? ` · 显存 ${(device.vram_total / 1024 ** 3).toFixed(1)} GB` : '';
        return `已连接 ComfyUI${version ? ` ${version}` : ''}${gpu ? ` · ${gpu}${vram}` : ''}。`;
    }
    catch (error) {
        if (signal?.aborted)
            throw abortError();
        if (error instanceof ImageResponseError)
            throw error;
        throw new ImageResponseError(`无法连接 ComfyUI（${baseOf(configured)}）。请确认服务已启动；若酒馆与 ComfyUI 不同源，需要用 --enable-cors-header 启动 ComfyUI，或在浏览器里放行跨域。`, 'network');
    }
    finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', relay);
    }
}
/** 面板上的「校验工作流」，异常统一转成可读提示。 */
export function inspectComfyWorkflow(source) {
    try {
        return describeComfyWorkflow(source);
    }
    catch (error) {
        if (error instanceof ComfyWorkflowError)
            fail(error.message, 'setup');
        throw error;
    }
}
/** 从 /history 的 outputs 里挑一张图：优先指定节点，其次第一个产出的节点。 */
function pickOutputImage(outputs, preferred) {
    const collect = (nodeId) => {
        const output = outputs[nodeId];
        if (!output || typeof output !== 'object')
            return [];
        const images = output.images;
        if (!Array.isArray(images))
            return [];
        const result = [];
        for (const item of images) {
            if (!item || typeof item !== 'object')
                continue;
            const record = item;
            if (typeof record.filename !== 'string' || !record.filename)
                continue;
            result.push({
                filename: record.filename,
                subfolder: typeof record.subfolder === 'string' ? record.subfolder : '',
                type: typeof record.type === 'string' ? record.type : 'output',
                nodeId,
            });
        }
        return result;
    };
    if (preferred) {
        const found = collect(preferred);
        if (found.length)
            return found[0];
    }
    const nodeIds = Object.keys(outputs);
    for (const nodeId of nodeIds) {
        const found = collect(nodeId).filter(image => image.type !== 'temp');
        if (found.length)
            return found[0];
    }
    for (const nodeId of nodeIds) {
        const found = collect(nodeId);
        if (found.length)
            return found[0];
    }
    return undefined;
}
function historyEntry(payload, promptId) {
    if (!payload || typeof payload !== 'object')
        return undefined;
    const entry = payload[promptId];
    if (!entry || typeof entry !== 'object')
        return undefined;
    return entry;
}
function executionError(execution) {
    const status = execution.status;
    if (!status || status.status_str !== 'error')
        return '';
    const messages = Array.isArray(status.messages) ? status.messages : [];
    for (const message of messages) {
        if (!Array.isArray(message) || message.length < 2)
            continue;
        const [kind, detail] = message;
        if (kind !== 'execution_error' || !detail || typeof detail !== 'object')
            continue;
        const record = detail;
        const nodeType = typeof record.node_type === 'string' ? record.node_type : '未知节点';
        const text = typeof record.exception_message === 'string' ? record.exception_message.split('\n')[0] : '';
        return `ComfyUI 执行失败（${nodeType}）：${text || '请打开 ComfyUI 控制台查看详细报错。'}`;
    }
    return 'ComfyUI 执行失败，请打开 ComfyUI 控制台查看详细报错。';
}
function queueSnapshot(payload) {
    const record = (payload ?? {});
    const read = (value) => {
        if (!Array.isArray(value))
            return [];
        return value.map(item => Array.isArray(item) && typeof item[1] === 'string' ? item[1] : '').filter(Boolean);
    };
    return { running: read(record.queue_running), pending: read(record.queue_pending) };
}
/**
 * 采样进度走 WebSocket（ComfyUI 会广播 progress 事件）；连不上就只靠队列轮询，
 * 这时面板显示排队位置而不是步数。
 */
function openProgressSocket(connection, clientId, promptOf, onStep, onExecuting, onError) {
    let socket = null;
    let closed = false;
    try {
        const base = new URL(baseOf(connection));
        const protocol = base.protocol === 'https:' ? 'wss:' : 'ws:';
        const path = `${base.pathname.replace(/\/+$/, '')}/ws?clientId=${encodeURIComponent(clientId)}`;
        socket = new WebSocket(`${protocol}//${base.host}${path}`);
    }
    catch {
        return { close: () => { } };
    }
    const current = socket;
    // 连不上只是少了步数显示，轮询仍然能跑完；不挂 error 处理会留下未处理事件。
    current.onerror = () => { closed = true; };
    current.onclose = () => { closed = true; };
    current.onmessage = event => {
        if (closed)
            return;
        const promptId = promptOf();
        if (!promptId)
            return;
        let message;
        try {
            message = JSON.parse(String(event.data));
        }
        catch {
            return;
        }
        if (!message || typeof message !== 'object')
            return;
        const record = message;
        const data = (record.data ?? {});
        const id = typeof data.prompt_id === 'string' ? data.prompt_id : '';
        if (id && id !== promptId)
            return;
        if (record.type === 'progress' && typeof data.value === 'number' && typeof data.max === 'number') {
            onStep(data.value, data.max);
            return;
        }
        if (record.type === 'executing' && data.prompt_id === promptId && data.node === null)
            onExecuting();
        if (record.type === 'execution_error') {
            const detail = typeof data.exception_message === 'string' ? data.exception_message.split('\n')[0] : '';
            onError(`ComfyUI 执行失败${detail ? `：${detail}` : '，请打开 ComfyUI 控制台查看。'}`);
        }
    };
    return {
        close: () => {
            closed = true;
            current.onmessage = null;
            try {
                current.close();
            }
            catch { /* 已关闭 */ }
        },
    };
}
/** 取消只删自己这一条队列项；只有确认自己是正在跑的那条时才发 /interrupt。 */
async function cancelComfyJob(connection, promptId) {
    try {
        const queue = queueSnapshot(await readJson(await fetch(`${baseOf(connection)}/queue`, { ...requestInit(connection), signal: AbortSignal.timeout(5000) })));
        await fetch(`${baseOf(connection)}/queue`, {
            ...requestInit(connection, 'application/json'),
            method: 'POST',
            body: JSON.stringify({ delete: [promptId] }),
            signal: AbortSignal.timeout(5000),
        });
        if (queue.running.includes(promptId)) {
            await fetch(`${baseOf(connection)}/interrupt`, { ...requestInit(connection, 'application/json'), method: 'POST', signal: AbortSignal.timeout(5000) });
        }
    }
    catch {
        // 取消失败不影响本地放弃；服务端任务由用户自行在 ComfyUI 里处理。
    }
}
export async function generateComfyImage(options) {
    const { signal, onProgress } = options;
    signal.throwIfAborted();
    const connection = validateComfyConnection(options.connection);
    const parameters = validateComfyImageParameters(options.parameters, () => fail('ComfyUI 生图参数无效，请检查步数、画幅和种子。', 'setup'));
    const workflow = validateComfyWorkflowSettings(options.workflow, () => fail('ComfyUI 工作流配置无效，请重新粘贴工作流。', 'setup'));
    if (typeof options.positive !== 'string' || !options.positive.trim())
        fail('请填写正面提示词。', 'setup');
    if (typeof options.negative !== 'string')
        fail('负面提示词格式无效。', 'setup');
    const seed = parameters.seed === -1 ? crypto.getRandomValues(new Uint32Array(1))[0] : parameters.seed;
    const injection = {
        positive: options.positive, negative: options.negative,
        steps: parameters.steps, cfg: parameters.cfg, seed, sampler: parameters.sampler, scheduler: parameters.scheduler,
        width: parameters.width, height: parameters.height, batch: parameters.batch,
    };
    // 注入在排队前完成：配置错误不该占用共享队列。
    const built = (() => {
        try {
            return buildComfyPrompt(workflow.workflow, injection);
        }
        catch (error) {
            if (error instanceof ComfyWorkflowError)
                fail(error.message, 'setup');
            throw error;
        }
    })();
    return queueImageGeneration(() => runComfyJob(connection, parameters, seed, built.prompt, built.applied, workflow, signal, onProgress), signal, onProgress);
}
async function runComfyJob(connection, parameters, seed, prompt, applied, workflow, signal, onProgress) {
    const base = baseOf(connection);
    const clientId = newClientId();
    const controller = new AbortController();
    let interruption = null;
    const interrupt = (error) => { interruption ??= error; controller.abort(); };
    const cancel = () => interrupt(abortError());
    const ensureActive = () => {
        if (interruption)
            throw interruption;
        if (signal.aborted)
            throw abortError();
    };
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted)
        cancel();
    let promptId = '';
    const socket = openProgressSocket(connection, clientId, () => promptId, (value, max) => onProgress?.({ state: 'generating', detail: `采样 ${value}/${max} 步` }), () => { }, message => interrupt(new ImageResponseError(message, 'unknown')));
    const deadline = Date.now() + workflow.timeoutSeconds * 1000;
    try {
        ensureActive();
        const submit = await fetch(`${base}/prompt`, {
            ...requestInit(connection, 'application/json'),
            method: 'POST',
            body: JSON.stringify({ client_id: clientId, prompt }),
            signal: controller.signal,
        });
        if (!submit.ok) {
            const detail = await submit.text().catch(() => '');
            if (submit.status === 404)
                fail('服务地址不是 ComfyUI 的 /prompt 接口，请检查端口与路径。', 'network');
            if (submit.status === 400)
                fail(`ComfyUI 拒绝了该工作流：${summariseComfyError(detail)}`, 'setup');
            fail(`提交工作流失败（HTTP ${submit.status}）${detail ? `：${summariseComfyError(detail)}` : ''}`, 'unknown');
        }
        const submitted = await readJson(submit);
        promptId = typeof submitted.prompt_id === 'string' ? submitted.prompt_id : '';
        if (!promptId)
            fail(`ComfyUI 没有返回任务号：${summariseComfyError(JSON.stringify(submitted))}`, 'setup');
        const nodeErrors = submitted.node_errors;
        if (nodeErrors && typeof nodeErrors === 'object' && Object.keys(nodeErrors).length) {
            // 已入队但节点参数有误会直接失败，这里提前告知而不是等到超时。
            onProgress?.({ state: 'generating', detail: '工作流已入队，但节点参数有警告' });
        }
        let lastDetail = '';
        while (true) {
            ensureActive();
            const historyResponse = await fetch(`${base}/history/${encodeURIComponent(promptId)}`, { ...requestInit(connection), signal: controller.signal });
            if (historyResponse.ok) {
                const execution = historyEntry(await readJson(historyResponse), promptId);
                if (execution) {
                    const failure = executionError(execution);
                    if (failure)
                        fail(failure, 'unknown');
                    const image = pickOutputImage(execution.outputs ?? {}, parameters.outputNode);
                    if (image) {
                        const view = new URL(`${base}/view`);
                        view.searchParams.set('filename', image.filename);
                        view.searchParams.set('subfolder', image.subfolder);
                        view.searchParams.set('type', image.type || 'output');
                        const response = await fetch(view.href, { ...requestInit(connection), signal: controller.signal });
                        if (!response.ok) {
                            void response.body?.cancel().catch(() => { });
                            fail(`读取生成结果失败（HTTP ${response.status}），任务已在 ComfyUI 完成但取图被拒绝。`, 'network');
                        }
                        const blob = await readImageResponse(response, controller.signal, ensureActive);
                        ensureActive();
                        return { blob, width: parameters.width, height: parameters.height, seed, applied };
                    }
                    if (execution.status?.completed)
                        fail('ComfyUI 任务已完成，但输出里没有图片。请确认工作流末端有 SaveImage 节点。', 'format');
                }
            }
            const queueResponse = await fetch(`${base}/queue`, { ...requestInit(connection), signal: controller.signal });
            if (queueResponse.ok) {
                const queue = queueSnapshot(await readJson(queueResponse));
                const running = queue.running.includes(promptId);
                const index = queue.pending.indexOf(promptId);
                const detail = running ? 'ComfyUI 正在采样…' : index >= 0 ? `等待 ComfyUI 执行 · 队列第 ${index + 1} 位` : '已提交，等待 ComfyUI 接单…';
                if (detail !== lastDetail) {
                    lastDetail = detail;
                    onProgress?.({ state: index >= 0 && !running ? 'queued' : 'generating', position: index + 1, detail });
                }
            }
            if (Date.now() > deadline) {
                fail(`等待 ComfyUI 超时（${workflow.timeoutSeconds} 秒），任务可能仍在服务端继续；没有自动重试。`, 'timeout');
            }
            await sleep(workflow.pollMs, controller.signal);
        }
    }
    catch (error) {
        if (interruption)
            throw interruption;
        if (error instanceof ImageResponseError)
            throw error;
        if (error instanceof DOMException && error.name === 'AbortError')
            throw abortError();
        return fail('ComfyUI 请求没有完成。请确认服务地址可访问；若酒馆与 ComfyUI 不同源，需要给 ComfyUI 加 --enable-cors-header 启动参数。', 'network');
    }
    finally {
        socket.close();
        signal.removeEventListener('abort', cancel);
        // 取消后才需要清理服务端任务；正常结束不动队列。
        if (interruption && promptId)
            void cancelComfyJob(connection, promptId);
        controller.abort();
    }
}
/** 只取 ComfyUI 报错里最有用的一行，避免把整页 HTML 或堆栈回显到界面。 */
function summariseComfyError(raw) {
    const text = raw.trim();
    if (!text)
        return '没有返回错误详情。';
    if (text.startsWith('<'))
        return '服务返回了网页而不是接口数据，请检查地址与跨域设置。';
    try {
        const payload = JSON.parse(text);
        const error = payload.error;
        if (typeof error === 'string' && error.trim())
            return error.trim().slice(0, 300);
        if (error && typeof error === 'object') {
            const record = error;
            const message = typeof record.message === 'string' ? record.message : '';
            const details = typeof record.details === 'string' ? record.details : '';
            const joined = [message, details].filter(Boolean).join(' · ');
            if (joined)
                return joined.slice(0, 300);
        }
        const nodeErrors = payload.node_errors;
        if (nodeErrors && typeof nodeErrors === 'object') {
            const first = Object.values(nodeErrors)[0];
            if (first && typeof first === 'object') {
                const errors = first.errors;
                if (Array.isArray(errors) && errors.length) {
                    const detail = errors[0];
                    const parts = [detail.message, detail.details].filter((item) => typeof item === 'string' && !!item.trim());
                    if (parts.length)
                        return parts.join(' · ').slice(0, 300);
                }
                const message = first.message;
                if (typeof message === 'string' && message.trim())
                    return message.slice(0, 300);
            }
        }
    }
    catch { /* 不是 JSON，按纯文本截断 */ }
    return text.slice(0, 300);
}
