import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { test } from 'node:test';
import { generateComfyImage, defaultComfyImageParameters, defaultComfyWorkflowSettings } from '../dist/comfyui-image.js';
import { crc32 } from '../dist/image-bytes.js';

function png() {
  function chunk(name, bytes) {
    const type = Buffer.from(name), length = Buffer.alloc(4), crc = Buffer.alloc(4);
    length.writeUInt32BE(bytes.length);
    crc.writeUInt32BE(crc32(Buffer.concat([type, bytes])));
    return Buffer.concat([length, type, bytes, crc]);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(8, 0);
  header.writeUInt32BE(8, 4);
  header[8] = 8; header[9] = 6;
  const rows = Buffer.alloc(8 * (1 + 8 * 4));
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(rows)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const image = png();
const connection = { channel: 'custom', url: 'http://comfy.test:8188', key: '', appendSuffix: false };

const workflow = JSON.stringify({
  3: { class_type: 'KSampler', inputs: {
    seed: 1, steps: 20, cfg: 8, sampler_name: 'euler', scheduler: 'normal', denoise: 1,
    model: ['4', 0], positive: ['6', 0], negative: ['7', 0], latent_image: ['5', 0],
  } },
  4: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'm.safetensors' } },
  5: { class_type: 'EmptyLatentImage', inputs: { width: 512, height: 512, batch_size: 1 } },
  6: { class_type: 'CLIPTextEncode', inputs: { text: 'old', clip: ['4', 1] } },
  7: { class_type: 'CLIPTextEncode', inputs: { text: 'old', clip: ['4', 1] } },
  8: { class_type: 'VAEDecode', inputs: { samples: ['3', 0], vae: ['4', 2] } },
  9: { class_type: 'SaveImage', inputs: { filename_prefix: 'c', images: ['8', 0] } },
});

const settings = () => ({ ...defaultComfyWorkflowSettings(), workflow, pollMs: 250, timeoutSeconds: 30 });
const parameters = (extra = {}) => ({ ...defaultComfyImageParameters(), seed: 4242, ...extra });

/** 默认行为：第一次查历史还没有结果，第二次返回成品图。 */
function intercept(t, overrides = {}) {
  const calls = [];
  const history = overrides.history ?? [
    null,
    { outputs: { 9: { images: [{ filename: 'out.png', subfolder: '', type: 'output' }] } }, status: { status_str: 'success', completed: true } },
  ];
  let poll = 0;
  t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
    const href = String(url);
    calls.push({ href, method: options.method ?? 'GET', body: options.body ? JSON.parse(options.body) : undefined });
    if (href.endsWith('/prompt')) return overrides.promptResponse ?? Response.json({ prompt_id: 'task-1' });
    if (href.includes('/history/')) {
      const value = history[Math.min(poll, history.length - 1)];
      poll += 1;
      return Response.json(value ? { 'task-1': value } : {});
    }
    if (href.endsWith('/queue')) return overrides.queue ?? Response.json({ queue_running: [[0, 'task-1', {}, {}, []]], queue_pending: [] });
    if (href.includes('/view?')) return new Response(image, { headers: { 'Content-Type': 'image/png' } });
    return new Response('', { status: 404 });
  });
  return calls;
}

test('提交工作流、轮询排队、取回图片字节', async t => {
  const calls = intercept(t);
  const result = await generateComfyImage({
    connection, workflow: settings(), parameters: parameters(),
    positive: 'masterpiece, 1girl', negative: 'lowres', signal: new AbortController().signal,
  });
  assert.equal(result.blob.type, 'image/png');
  assert.equal(result.seed, 4242);
  const submit = calls.find(call => call.href.endsWith('/prompt')).body;
  assert.ok(submit.client_id, 'client_id 必须带上，ComfyUI 才认这次请求');
  assert.equal(submit.prompt['6'].inputs.text, 'masterpiece, 1girl');
  assert.equal(submit.prompt['7'].inputs.text, 'lowres');
  assert.equal(submit.prompt['3'].inputs.steps, 28);
  assert.equal(submit.prompt['3'].inputs.seed, 4242);
  assert.equal(submit.prompt['5'].inputs.width, 832);
  assert.ok(calls.some(call => call.href.includes('/view?filename=out.png')));
});

test('随机种子 -1 会落成一个具体数字', async t => {
  const calls = intercept(t);
  const result = await generateComfyImage({
    connection, workflow: settings(), parameters: parameters({ seed: -1 }),
    positive: 'p', negative: '', signal: new AbortController().signal,
  });
  assert.ok(Number.isInteger(result.seed) && result.seed >= 0);
  const submit = calls.find(call => call.href.endsWith('/prompt')).body;
  assert.equal(submit.prompt['3'].inputs.seed, result.seed);
});

test('执行失败时把 ComfyUI 的报错转成中文提示', async t => {
  const calls = intercept(t, { history: [{ outputs: {}, status: {
    status_str: 'error', completed: false,
    messages: [['execution_error', { node_type: 'KSampler', exception_message: 'CUDA out of memory\n堆栈...' }]],
  } }] });
  await assert.rejects(
    () => generateComfyImage({ connection, workflow: settings(), parameters: parameters(), positive: 'p', negative: '', signal: new AbortController().signal }),
    /KSampler.*CUDA out of memory/,
  );
  assert.ok(calls.some(call => call.href.includes('/history/')));
});

test('任务完成但没有图片时提示检查 SaveImage', async t => {
  intercept(t, { history: [{ outputs: {}, status: { status_str: 'success', completed: true } }] });
  await assert.rejects(
    () => generateComfyImage({ connection, workflow: settings(), parameters: parameters(), positive: 'p', negative: '', signal: new AbortController().signal }),
    /没有图片.*SaveImage/,
  );
});

test('400 会带出节点错误详情', async t => {
  intercept(t, { promptResponse: new Response(JSON.stringify({
    error: { message: 'Prompt outputs failed validation', details: '' },
    node_errors: { 4: { errors: [{ message: 'Value not in list', details: 'ckpt_name: m.safetensors' }] } },
  }), { status: 400 }) });
  await assert.rejects(
    () => generateComfyImage({ connection, workflow: settings(), parameters: parameters(), positive: 'p', negative: '', signal: new AbortController().signal }),
    /ComfyUI 拒绝了该工作流/,
  );
});

test('跨域被拦时提示需要 enable-cors-header', async t => {
  t.mock.method(globalThis, 'fetch', async () => { throw new TypeError('Failed to fetch'); });
  await assert.rejects(
    () => generateComfyImage({ connection, workflow: settings(), parameters: parameters(), positive: 'p', negative: '', signal: new AbortController().signal }),
    /enable-cors-header/,
  );
});

test('取消时中断等待并清理服务端队列项', async t => {
  const controller = new AbortController();
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
    const href = String(url);
    calls.push({ href, method: options.method ?? 'GET' });
    if (href.endsWith('/prompt')) return Response.json({ prompt_id: 'task-2' });
    if (href.includes('/history/')) return Response.json({});
    if (href.endsWith('/queue') && options.method === 'POST') return Response.json({});
    if (href.endsWith('/queue')) {
      // 第一次轮询后取消，模拟用户点了「取消等待」。
      if (calls.filter(call => call.href.endsWith('/queue')).length >= 2) controller.abort();
      return Response.json({ queue_running: [], queue_pending: [[1, 'task-2', {}, {}, []]] });
    }
    return new Response('', { status: 404 });
  });
  await assert.rejects(
    () => generateComfyImage({
      connection, workflow: settings(), parameters: parameters(), positive: 'p', negative: '', signal: controller.signal,
    }),
    error => error.name === 'AbortError',
  );
  // 服务端清理由 finally 里 fire-and-forget 触发，给它一个宏任务的时间落地。
  await new Promise(resolve => setTimeout(resolve, 50));
  const deletes = calls.filter(call => call.method === 'POST' && call.href.endsWith('/queue'));
  assert.ok(deletes.length >= 1, '取消后应删除自己的队列项');
});

test('工作流不合法时不占用队列，直接报错', async t => {
  const calls = intercept(t);
  await assert.rejects(
    () => generateComfyImage({
      connection, workflow: { ...settings(), workflow: '{"nodes":[],"links":[]}' }, parameters: parameters(),
      positive: 'p', negative: '', signal: new AbortController().signal,
    }),
    /界面格式/,
  );
  assert.equal(calls.length, 0, '配置错误必须在发请求前就被拦下');
});
