import assert from 'node:assert/strict';
import { test } from 'node:test';
import { analyseComfyWorkflow, buildComfyPrompt, describeComfyWorkflow, parseComfyWorkflow, COMFY_PLACEHOLDERS } from '../dist/comfyui-workflow.js';
import {
  defaultComfyImageParameters, defaultComfyWorkflowSettings, validateComfyConnection, validateComfyImageParameters,
} from '../dist/comfyui-image.js';
import { defaultAllImageSettings, validateAllImageSettings, validateImageSettings, imageProviderName } from '../dist/image-settings.js';
import { imageSettingsView } from '../dist/image-view.js';

const injection = (extra = {}) => ({
  positive: 'masterpiece, 1girl, cherry blossoms', negative: 'blurry, bad hands',
  steps: 30, cfg: 7.5, seed: 12345, sampler: 'dpmpp_2m', scheduler: 'karras',
  width: 832, height: 1216, batch: 2, ...extra,
});

/** 典型的 SD1.5 / SDXL 工作流结构：KSampler → CLIPTextEncode ×2 → EmptyLatentImage。 */
function classicWorkflow(textClass = 'CLIPTextEncode') {
  return {
    3: { class_type: 'KSampler', inputs: {
      seed: 156680208700286, steps: 20, cfg: 8, sampler_name: 'euler', scheduler: 'normal', denoise: 1,
      model: ['4', 0], positive: ['6', 0], negative: ['7', 0], latent_image: ['5', 0],
    } },
    4: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'dreamshaper_8.safetensors' } },
    5: { class_type: 'EmptyLatentImage', inputs: { width: 512, height: 512, batch_size: 1 } },
    6: { class_type: textClass, inputs: { text: 'a cat', clip: ['4', 1] } },
    7: { class_type: textClass, inputs: { text: 'blurry', clip: ['4', 1] } },
    8: { class_type: 'VAEDecode', inputs: { samples: ['3', 0], vae: ['4', 2] } },
    9: { class_type: 'SaveImage', inputs: { filename_prefix: 'ComfyUI', images: ['8', 0] } },
  };
}

/** 新式拆分工作流：CFGGuider + RandomNoise + KSamplerSelect + BasicScheduler。 */
function splitWorkflow() {
  return {
    1: { class_type: 'CFGGuider', inputs: { model: ['2', 0], positive: ['3', 0], negative: ['4', 0], cfg: 3.5 } },
    2: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'flux1-dev.safetensors' } },
    3: { class_type: 'CLIPTextEncode', inputs: { text: 'cat', clip: ['2', 1] } },
    4: { class_type: 'ConditioningZeroOut', inputs: { conditioning: ['5', 0] } },
    5: { class_type: 'CLIPTextEncode', inputs: { text: 'unused', clip: ['2', 1] } },
    6: { class_type: 'KSamplerSelect', inputs: { sampler_name: 'euler' } },
    7: { class_type: 'RandomNoise', inputs: { noise_seed: 0 } },
    8: { class_type: 'BasicScheduler', inputs: { model: ['2', 0], scheduler: 'simple', steps: 20, denoise: 1 } },
    9: { class_type: 'EmptySD3LatentImage', inputs: { width: 1024, height: 1024, batch_size: 1 } },
    10: { class_type: 'SamplerCustomAdvanced', inputs: {
      noise: ['7', 0], guider: ['1', 0], sampler: ['6', 0], sigmas: ['8', 0], latent_image: ['9', 0],
    } },
    11: { class_type: 'SaveImage', inputs: { filename_prefix: 'flux', images: ['10', 0] } },
  };
}

test('自动识别经典工作流的正负面、采样器与画幅', () => {
  const analysis = analyseComfyWorkflow(parseComfyWorkflow(JSON.stringify(classicWorkflow())));
  assert.equal(analysis.positive.nodeId, '6');
  assert.equal(analysis.negative.nodeId, '7');
  assert.deepEqual(analysis.positive.fields, ['text']);
  assert.equal(analysis.sampler.nodeId, '3');
  assert.equal(analysis.sampler.seedField, 'seed');
  assert.equal(analysis.size.nodeId, '5');
  assert.equal(analysis.size.batchField, 'batch_size');
  assert.deepEqual(analysis.outputNodes, ['9']);
  assert.equal(analysis.placeholders.length, 0);
});

test('自动识别把采样参数与画幅写进对应节点', () => {
  const built = buildComfyPrompt(JSON.stringify(classicWorkflow()), injection());
  const sampler = built.prompt['3'].inputs;
  assert.equal(sampler.seed, 12345);
  assert.equal(sampler.steps, 30);
  assert.equal(sampler.cfg, 7.5);
  assert.equal(sampler.sampler_name, 'dpmpp_2m');
  assert.equal(sampler.scheduler, 'karras');
  assert.equal(built.prompt['6'].inputs.text, 'masterpiece, 1girl, cherry blossoms');
  assert.equal(built.prompt['7'].inputs.text, 'blurry, bad hands');
  assert.equal(built.prompt['5'].inputs.width, 832);
  assert.equal(built.prompt['5'].inputs.height, 1216);
  assert.equal(built.prompt['5'].inputs.batch_size, 2);
  // 未涉及的节点必须原样保留。
  assert.equal(built.prompt['4'].inputs.ckpt_name, 'dreamshaper_8.safetensors');
  assert.equal(built.prompt['9'].inputs.filename_prefix, 'ComfyUI');
  assert.deepEqual(built.warnings, []);
});

test('空的负面词会清空节点，而不是写入 undefined', () => {
  const built = buildComfyPrompt(JSON.stringify(classicWorkflow()), injection({ negative: '' }));
  assert.equal(built.prompt['7'].inputs.text, '');
});

test('SamplerCustom 拆分式工作流按字段名兜底写入', () => {
  const built = buildComfyPrompt(JSON.stringify(splitWorkflow()), injection());
  assert.equal(built.prompt['1'].inputs.cfg, 7.5, 'CFG 应写进 CFGGuider');
  assert.equal(built.prompt['8'].inputs.steps, 30, '步数应写进 BasicScheduler');
  assert.equal(built.prompt['8'].inputs.scheduler, 'karras');
  assert.equal(built.prompt['7'].inputs.noise_seed, 12345, '种子应写进 RandomNoise 的 noise_seed');
  assert.equal(built.prompt['6'].inputs.sampler_name, 'dpmpp_2m', '采样器应写进 KSamplerSelect');
  assert.equal(built.prompt['9'].inputs.width, 832);
  assert.equal(built.prompt['9'].inputs.height, 1216);
  assert.equal(built.prompt['3'].inputs.text, 'masterpiece, 1girl, cherry blossoms');
});

test('ConditioningZeroOut 表示这一路本来就该是空负面词', () => {
  const analysis = analyseComfyWorkflow(parseComfyWorkflow(JSON.stringify(splitWorkflow())));
  assert.equal(analysis.negative, undefined);
  assert.match(analysis.lines.join('\n'), /负面提示词 → 未接入/);
  // 带负面词生成时不应报错，只应提示忽略。
  const built = buildComfyPrompt(JSON.stringify(splitWorkflow()), injection());
  assert.ok(built.warnings.some(warning => warning.includes('没有可写入的负面提示词节点')));
  assert.equal(built.prompt['5'].inputs.text, 'unused', '上游被置空的编码器不应被改写');
});

test('SDXL 双文本字段会同时写入', () => {
  const workflow = classicWorkflow('CLIPTextEncodeSDXL');
  workflow[6] = { class_type: 'CLIPTextEncodeSDXL', inputs: { text_g: 'g', text_l: 'l', clip: ['4', 1] } };
  workflow[7] = { class_type: 'CLIPTextEncodeSDXL', inputs: { text_g: 'g', text_l: 'l', clip: ['4', 1] } };
  const built = buildComfyPrompt(JSON.stringify(workflow), injection());
  assert.equal(built.prompt['6'].inputs.text_g, 'masterpiece, 1girl, cherry blossoms');
  assert.equal(built.prompt['6'].inputs.text_l, 'masterpiece, 1girl, cherry blossoms');
});

test('占位符整值替换会把数字还原成数字类型', () => {
  const workflow = classicWorkflow();
  workflow[3].inputs.steps = '%steps%';
  workflow[3].inputs.seed = '%seed%';
  workflow[3].inputs.cfg = '%cfg_scale%';
  workflow[6].inputs.text = '%prompt%';
  workflow[7].inputs.text = '%negative_prompt%';
  const built = buildComfyPrompt(JSON.stringify(workflow), injection());
  assert.equal(built.prompt['3'].inputs.steps, 30);
  assert.equal(typeof built.prompt['3'].inputs.steps, 'number');
  assert.equal(built.prompt['3'].inputs.seed, 12345);
  assert.equal(typeof built.prompt['3'].inputs.cfg, 'number');
  assert.equal(built.prompt['6'].inputs.text, 'masterpiece, 1girl, cherry blossoms');
  assert.ok(built.applied.some(item => item.includes('%prompt%')));
});

test('占位符支持子串拼接', () => {
  const workflow = classicWorkflow();
  workflow[6].inputs.text = 'masterpiece, %prompt%, best quality';
  const built = buildComfyPrompt(JSON.stringify(workflow), injection());
  assert.equal(built.prompt['6'].inputs.text, 'masterpiece, masterpiece, 1girl, cherry blossoms, best quality');
});

test('占位符优先于自动识别，不会被覆盖', () => {
  const workflow = classicWorkflow();
  workflow[3].inputs.steps = '%steps%';
  const built = buildComfyPrompt(JSON.stringify(workflow), injection({ steps: 99 }));
  assert.equal(built.prompt['3'].inputs.steps, 99, '占位符写入的值必须保留');
});

test('空白采样器/调度器不覆盖工作流原值', () => {
  const built = buildComfyPrompt(JSON.stringify(classicWorkflow()), injection({ sampler: '', scheduler: '' }));
  assert.equal(built.prompt['3'].inputs.sampler_name, 'euler');
  assert.equal(built.prompt['3'].inputs.scheduler, 'normal');
});

test('界面格式工作流给出可执行的提示', () => {
  const uiFormat = { nodes: [{ id: 3, type: 'KSampler' }], links: [] };
  assert.throws(() => parseComfyWorkflow(JSON.stringify(uiFormat)), /界面格式/);
});

test('带 prompt 外壳的工作流可以直接粘贴', () => {
  const graph = parseComfyWorkflow(JSON.stringify({ prompt: classicWorkflow() }));
  assert.equal(Object.keys(graph).length, 7);
});

test('没有提示词节点时拒绝生成', () => {
  const workflow = classicWorkflow();
  delete workflow[6];
  delete workflow[7];
  workflow[3].inputs.positive = ['4', 0];
  workflow[3].inputs.negative = ['4', 0];
  assert.throws(() => buildComfyPrompt(JSON.stringify(workflow), injection()), /未能在工作流里找到提示词写入点/);
});

test('非法 JSON 与空输入都有明确报错', () => {
  assert.throws(() => parseComfyWorkflow(''), /请先粘贴/);
  assert.throws(() => parseComfyWorkflow('{ not json'), /JSON 无效/);
  assert.throws(() => parseComfyWorkflow('{"1":{"class_type":"KSampler","inputs":{"steps":"%steps%"'), /JSON 无效/);
});

test('校验报告列出识别结果与占位符', () => {
  const report = describeComfyWorkflow(JSON.stringify(classicWorkflow()));
  assert.equal(report.nodes, 7);
  assert.deepEqual(report.placeholders, []);
  assert.match(report.lines.join('\n'), /正面提示词 → 节点 6/);
  assert.match(report.lines.join('\n'), /采样参数 → 节点 3/);
  assert.match(report.lines.join('\n'), /画幅 → 节点 5/);
});

test('占位符清单与设置字段一一对应', () => {
  const tokens = COMFY_PLACEHOLDERS.map(item => item.token);
  assert.deepEqual(tokens, ['%prompt%', '%negative_prompt%', '%steps%', '%cfg_scale%', '%seed%', '%sampler_name%', '%scheduler%', '%width%', '%height%', '%batch_size%']);
});

test('连接校验接受空密钥、拒绝非法地址', () => {
  const configured = validateComfyConnection({ channel: 'custom', url: 'http://127.0.0.1:8188/', key: '', appendSuffix: false });
  assert.equal(configured.url, 'http://127.0.0.1:8188');
  assert.equal(configured.channel, 'custom');
  assert.throws(() => validateComfyConnection({ channel: 'custom', url: '', key: '', appendSuffix: false }), /请填写 ComfyUI 的服务地址/);
  assert.throws(() => validateComfyConnection({ channel: 'custom', url: '127.0.0.1:8188', key: '', appendSuffix: false }), /包含 http/);
  assert.throws(() => validateComfyConnection({ channel: 'custom', url: 'http://u:p@127.0.0.1:8188', key: '', appendSuffix: false }), /不能包含账号/);
});

test('生图参数边界校验', () => {
  const invalid = () => { throw new Error('invalid'); };
  assert.deepEqual(validateComfyImageParameters(defaultComfyImageParameters(), invalid), defaultComfyImageParameters());
  assert.throws(() => validateComfyImageParameters({ ...defaultComfyImageParameters(), steps: 0 }, invalid), /invalid/);
  assert.throws(() => validateComfyImageParameters({ ...defaultComfyImageParameters(), width: 32 }, invalid), /invalid/);
  assert.throws(() => validateComfyImageParameters({ ...defaultComfyImageParameters(), batch: 99 }, invalid), /invalid/);
  assert.throws(() => validateComfyImageParameters({ ...defaultComfyImageParameters(), seed: -2 }, invalid), /invalid/);
});

test('ComfyUI 配置进入总设置并通过序列化往返', () => {
  const all = defaultAllImageSettings();
  assert.equal(all.profiles.comfy.connection.url, 'http://127.0.0.1:8188');
  assert.equal(all.profiles.comfy.connection.channel, 'custom');
  assert.equal(imageProviderName('comfy'), 'ComfyUI');
  const workflow = defaultComfyWorkflowSettings();
  workflow.workflow = JSON.stringify(classicWorkflow());
  all.profiles.comfy.comfyWorkflow = workflow;
  all.profiles.comfy.negative = 'lowres';
  const roundTrip = validateAllImageSettings(JSON.parse(JSON.stringify(all)));
  assert.equal(roundTrip.profiles.comfy.comfyWorkflow.workflow, workflow.workflow);
  assert.equal(roundTrip.profiles.comfy.negative, 'lowres', 'ComfyUI 允许独立负面词');
});

test('旧版四通道配置导入时自动补齐 ComfyUI', () => {
  const legacy = { version: 2, activeProvider: 'novelai', profiles: {
    novelai: defaultAllImageSettings().profiles.novelai,
    openai: defaultAllImageSettings().profiles.openai,
    gemini: defaultAllImageSettings().profiles.gemini,
    grok: defaultAllImageSettings().profiles.grok,
  } };
  const parsed = validateAllImageSettings(legacy);
  assert.equal(parsed.profiles.comfy.provider, 'comfy');
  assert.equal(parsed.profiles.comfy.comfyWorkflow.workflow, '');
});

test('GPT 仍拒绝负面词，ComfyUI 不拒绝', () => {
  const openai = { ...defaultAllImageSettings().profiles.openai, negative: 'lowres' };
  assert.throws(() => validateImageSettings(openai), /不支持独立负面提示词/);
  const comfy = { ...defaultAllImageSettings().profiles.comfy, negative: 'lowres' };
  assert.equal(validateImageSettings(comfy).negative, 'lowres');
});

const viewState = () => ({ connectionName: '', artistName: '', connectionSaved: false, refreshing: false, moreOpen: true });

test('ComfyUI 面板包含工作流、测试连接与负面栏，且不要密钥栏', () => {
  const html = imageSettingsView(defaultAllImageSettings().profiles.comfy, viewState());
  assert.match(html, /data-parameter="workflow"/);
  assert.match(html, /data-action="test-connection"/);
  assert.match(html, /data-action="inspect-workflow"/);
  assert.match(html, /data-workflow-report/);
  assert.match(html, /%prompt%/);
  assert.match(html, /%negative_prompt%/);
  assert.match(html, /data-parameter="scheduler"/);
  assert.match(html, /<span>负面提示词<\/span>/);
  // ComfyUI 不需要密钥，也不该出现 NAI 的氛围参考。
  assert.doesNotMatch(html, /data-connection="key"/);
  assert.doesNotMatch(html, /data-vibe-host/);
  assert.doesNotMatch(html, /data-parameter="model"/);
});

test('其他画笔不会被塞进 ComfyUI 面板', () => {
  for (const provider of ['novelai', 'openai', 'gemini', 'grok']) {
    const html = imageSettingsView(defaultAllImageSettings().profiles[provider], viewState());
    assert.doesNotMatch(html, /comfy-workflow-field/, `${provider} 不应出现工作流输入框`);
    assert.doesNotMatch(html, /data-action="test-connection"/, `${provider} 不应出现连接测试`);
  }
  // NAI 保留自己的密钥栏与氛围参考。
  const nai = imageSettingsView(defaultAllImageSettings().profiles.novelai, viewState());
  assert.match(nai, /data-connection="key"/);
  assert.match(nai, /data-vibe-host/);
});
