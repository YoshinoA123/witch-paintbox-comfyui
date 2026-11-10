/**
 * ComfyUI 工作流分析与参数注入。
 *
 * 两条注入路径同时生效，互不抢夺字段：
 * 1. 占位符：在工作流里写 `"%prompt%"`、`"%steps%"`，按整值/子串替换，数值会还原成数字；
 * 2. 自动识别：读采样器的 positive/negative 连线，向上游追到 CLIPTextEncode，再从
 *    EmptyLatentImage 取画幅。用户粘贴 ComfyUI 原始「API 格式」导出即可，无需改工作流。
 *
 * 占位符优先：已被占位符占用的字段，自动识别不会再覆盖。
 */

export type ComfyFieldKey =
  | 'prompt' | 'negative' | 'steps' | 'cfg' | 'seed' | 'sampler' | 'scheduler' | 'width' | 'height' | 'batch';

export interface ComfyPlaceholder {
  token: string;
  key: ComfyFieldKey;
  kind: 'text' | 'number';
  label: string;
}

/** 与设置面板字段一一对应，不留无法填值的占位符。 */
export const COMFY_PLACEHOLDERS: readonly ComfyPlaceholder[] = [
  { token: '%prompt%', key: 'prompt', kind: 'text', label: '正面提示词' },
  { token: '%negative_prompt%', key: 'negative', kind: 'text', label: '负面提示词' },
  { token: '%steps%', key: 'steps', kind: 'number', label: '步数' },
  { token: '%cfg_scale%', key: 'cfg', kind: 'number', label: 'CFG' },
  { token: '%seed%', key: 'seed', kind: 'number', label: '种子' },
  { token: '%sampler_name%', key: 'sampler', kind: 'text', label: '采样器' },
  { token: '%scheduler%', key: 'scheduler', kind: 'text', label: '调度器' },
  { token: '%width%', key: 'width', kind: 'number', label: '宽度' },
  { token: '%height%', key: 'height', kind: 'number', label: '高度' },
  { token: '%batch_size%', key: 'batch', kind: 'number', label: '单批张数' },
];

export interface ComfyWorkflowNode {
  class_type: string;
  inputs: Record<string, unknown>;
  _meta?: unknown;
}

export type ComfyPromptGraph = Record<string, ComfyWorkflowNode>;

export interface ComfyInjection {
  positive: string;
  negative: string;
  steps: number;
  cfg: number;
  seed: number;
  /** 空字符串表示沿用工作流原值。 */
  sampler: string;
  scheduler: string;
  width: number;
  height: number;
  batch: number;
}

export interface ComfyTarget {
  nodeId: string;
  classType: string;
  fields: string[];
}

export interface ComfyAnalysis {
  positive?: ComfyTarget;
  negative?: ComfyTarget;
  sampler?: { nodeId: string; classType: string; seedField: string };
  size?: { nodeId: string; classType: string; batchField: string };
  placeholders: string[];
  outputNodes: string[];
  /** 供设置面板逐行展示的中文识别结果。 */
  lines: string[];
  warnings: string[];
}

export interface ComfyBuildResult {
  prompt: ComfyPromptGraph;
  /** 实际写入的字段，用于面板回显与失败排查。 */
  applied: string[];
  warnings: string[];
  analysis: ComfyAnalysis;
}

/** ComfyUI 的节点标题上限；超过这个长度基本可以断定用户粘错了东西。 */
const MAX_WORKFLOW_LENGTH = 512 * 1024;
const MAX_TEXT_LENGTH = 2_000_000;

const TEXT_ENCODER = /text.?encode|prompt.?encoder/i;
const CONDITIONING_PASSTHROUGH = new Set([
  'ConditioningCombine', 'ConditioningConcat', 'ConditioningAverage',
  'ConditioningSetArea', 'ConditioningSetAreaPercentage', 'ConditioningSetAreaStrength',
  'ConditioningSetMask', 'ConditioningSetTimestepRange', 'ConditioningSetProperties',
  'ConditioningSetPropertiesAndCombine', 'ConditioningSetDefaultAndCombine',
  'FluxGuidance', 'ControlNetApply', 'ControlNetApplyAdvanced', 'ControlNetApplySD3',
  'StyleModelApply', 'ConditioningSetTimestepRange',
]);
/** 明确把条件置空的节点：说明这一路本来就该是空负面词，不再向上游找。 */
const EMPTY_CONDITIONING = new Set(['ConditioningZeroOut']);
const CONDITIONING_INPUTS = ['conditioning', 'conditioning_1', 'conditioning_to', 'conditioning_from', 'positive', 'conditioning_2'];
const TEXT_ALIASES = ['clip_l', 't5xxl', 'text_g', 'text_l', 'prompt'];
const SIZE_INPUTS = ['samples', 'latent', 'latent_image'];
const MAX_TRACE_DEPTH = 10;

export class ComfyWorkflowError extends Error {}

function fail(message: string): never {
  throw new ComfyWorkflowError(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isNode(value: unknown): value is ComfyWorkflowNode {
  return isRecord(value) && typeof value.class_type === 'string' && isRecord(value.inputs);
}

/** 连线在 API 格式里是 `[节点 id, 输出槽位]`，id 可能是字符串也可能是数字。 */
function resolveLink(value: unknown): { nodeId: string; slot: number } | null {
  if (!Array.isArray(value) || value.length < 2) return null;
  const rawId = value[0];
  const slot = value[1];
  if (typeof slot !== 'number' || !Number.isFinite(slot)) return null;
  if (typeof rawId === 'string' && rawId.trim()) return { nodeId: rawId, slot };
  if (typeof rawId === 'number' && Number.isFinite(rawId)) return { nodeId: String(rawId), slot };
  return null;
}

/** 文本编码器里可写的字段：优先 text，其次 SDXL/Flux 的双字段，最后才是自定义节点。 */
function textFields(node: ComfyWorkflowNode): string[] {
  if (!TEXT_ENCODER.test(node.class_type)) return [];
  const inputs = node.inputs;
  if (typeof inputs.text === 'string' && inputs.text.length <= MAX_TEXT_LENGTH) return ['text'];
  const aliases = TEXT_ALIASES.filter(key => typeof inputs[key] === 'string' && (inputs[key] as string).length <= MAX_TEXT_LENGTH);
  return aliases;
}

function traceText(graph: ComfyPromptGraph, value: unknown, depth = 0): ComfyTarget | undefined {
  if (depth > MAX_TRACE_DEPTH) return undefined;
  const link = resolveLink(value);
  if (!link) return undefined;
  const node = graph[link.nodeId];
  if (!node) return undefined;
  if (EMPTY_CONDITIONING.has(node.class_type)) return undefined;
  const fields = textFields(node);
  if (fields.length) return { nodeId: link.nodeId, classType: node.class_type, fields };
  if (!CONDITIONING_PASSTHROUGH.has(node.class_type)) {
    // 未登记的中转节点仍然按「第一个可解析的条件输入」尝试一次，但不再扩散。
    if (!Object.keys(node.inputs).some(key => CONDITIONING_INPUTS.includes(key))) return undefined;
  }
  for (const key of CONDITIONING_INPUTS) {
    const found = traceText(graph, node.inputs[key], depth + 1);
    if (found) return found;
  }
  return undefined;
}

interface SamplerHit {
  nodeId: string;
  node: ComfyWorkflowNode;
  score: number;
}

/** 采样节点没有统一的 class_type，按「有 positive 连线 + 有 steps/cfg」打分挑最像的。 */
function findSampler(graph: ComfyPromptGraph): SamplerHit | undefined {
  let best: SamplerHit | undefined;
  for (const [nodeId, node] of Object.entries(graph)) {
    const inputs = node.inputs;
    const hasPositive = resolveLink(inputs.positive) !== null;
    const hasSteps = typeof inputs.steps === 'number';
    if (!hasPositive && !hasSteps) continue;
    const score = (hasPositive ? 2 : 0) + (hasSteps ? 2 : 0)
      + (typeof inputs.cfg === 'number' ? 1 : 0)
      + (typeof inputs.sampler_name === 'string' ? 1 : 0)
      + (typeof inputs.seed === 'number' || typeof inputs.noise_seed === 'number' ? 1 : 0);
    if (!best || score > best.score) best = { nodeId, node, score };
  }
  return best;
}

function traceSize(graph: ComfyPromptGraph, value: unknown, depth = 0): ComfyAnalysis['size'] {
  if (depth > MAX_TRACE_DEPTH) return undefined;
  const link = resolveLink(value);
  if (!link) return undefined;
  const node = graph[link.nodeId];
  if (!node) return undefined;
  const inputs = node.inputs;
  if (typeof inputs.width === 'number' && typeof inputs.height === 'number') {
    return { nodeId: link.nodeId, classType: node.class_type, batchField: typeof inputs.batch_size === 'number' ? 'batch_size' : '' };
  }
  for (const key of SIZE_INPUTS) {
    const found = traceSize(graph, inputs[key], depth + 1);
    if (found) return found;
  }
  return undefined;
}

/** 只识别「API 格式」；UI 格式（nodes/links）无法直接提交，必须提示用户重新导出。 */
export function parseComfyWorkflow(source: string): ComfyPromptGraph {
  const text = source.trim();
  if (!text) fail('请先粘贴 ComfyUI 的 API 格式工作流 JSON。');
  if (text.length > MAX_WORKFLOW_LENGTH) fail('工作流 JSON 超过 512 KB，请检查是否粘贴了图片或整页 HTML。');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    fail(text.includes('%')
      ? '工作流 JSON 无效。占位符必须包在引号里，例如 "text": "%prompt%"、"steps": "%steps%"。'
      : '工作流 JSON 无效，请粘贴完整的 JSON 文本。');
  }
  if (!isRecord(parsed)) fail('工作流必须是 JSON 对象。');
  // 允许直接粘贴 { "prompt": { ... } } 这种带外壳的写法。
  const inner = isRecord(parsed.prompt) ? parsed.prompt : parsed;
  if (Array.isArray(parsed.nodes) || Array.isArray((parsed as { links?: unknown }).links)) {
    fail('这是 ComfyUI 的「界面格式」工作流，无法直接提交。请在 ComfyUI 里用「Save (API Format)」或「Export (API)」重新导出。');
  }
  const graph: ComfyPromptGraph = {};
  for (const [nodeId, value] of Object.entries(inner)) {
    if (!isNode(value)) continue;
    graph[nodeId] = { class_type: value.class_type, inputs: value.inputs, ...(value._meta === undefined ? {} : { _meta: value._meta }) };
  }
  if (!Object.keys(graph).length) {
    fail('工作流里没有可执行的节点。请确认导出的是「API 格式」，而不是界面格式或纯节点模板。');
  }
  return graph;
}

function scanPlaceholders(graph: ComfyPromptGraph): string[] {
  const found = new Set<string>();
  const walk = (value: unknown, key: string): void => {
    if (key === '_meta') return;
    if (typeof value === 'string') {
      for (const placeholder of COMFY_PLACEHOLDERS) if (value.includes(placeholder.token)) found.add(placeholder.token);
      return;
    }
    if (Array.isArray(value)) { for (const item of value) walk(item, key); return; }
    if (isRecord(value)) { for (const [childKey, child] of Object.entries(value)) walk(child, childKey); }
  };
  walk(graph, '');
  return COMFY_PLACEHOLDERS.filter(placeholder => found.has(placeholder.token)).map(placeholder => placeholder.token);
}

function outputNodes(graph: ComfyPromptGraph): string[] {
  return Object.keys(graph).filter(nodeId => /save|preview|display/i.test(graph[nodeId].class_type));
}

export function analyseComfyWorkflow(graph: ComfyPromptGraph): ComfyAnalysis {
  const analysis: ComfyAnalysis = { placeholders: scanPlaceholders(graph), outputNodes: outputNodes(graph), lines: [], warnings: [] };
  const sampler = findSampler(graph);
  if (sampler) {
    const inputs = sampler.node.inputs;
    const seedField = typeof inputs.seed === 'number' ? 'seed' : typeof inputs.noise_seed === 'number' ? 'noise_seed' : '';
    analysis.sampler = { nodeId: sampler.nodeId, classType: sampler.node.class_type, seedField };
    analysis.positive = traceText(graph, inputs.positive);
    analysis.negative = traceText(graph, inputs.negative);
    analysis.size = traceSize(graph, inputs.latent_image) ?? traceSize(graph, inputs.latent);
  }
  if (!analysis.positive) {
    // 采样器没连 positive 时（SamplerCustom 一类），退回全局搜索第一个文本编码器。
    for (const [nodeId, node] of Object.entries(graph)) {
      const fields = textFields(node);
      if (fields.length) { analysis.positive = { nodeId, classType: node.class_type, fields }; break; }
    }
    if (analysis.positive) analysis.warnings.push('采样器没有正向连线，已按文档顺序取第一个文本编码器，请核对预览。');
  }
  if (!analysis.size) analysis.warnings.push('没有识别到画幅节点，宽高将由工作流自身决定。');
  const describe = (label: string, target?: ComfyTarget) => {
    if (!target) return;
    analysis.lines.push(`${label} → 节点 ${target.nodeId} · ${target.classType}${target.fields.length > 1 ? `（${target.fields.join(' / ')}）` : ''}`);
  };
  describe('正面提示词', analysis.positive);
  describe('负面提示词', analysis.negative);
  if (analysis.sampler) analysis.lines.push(`采样参数 → 节点 ${analysis.sampler.nodeId} · ${analysis.sampler.classType}`);
  if (analysis.size) analysis.lines.push(`画幅 → 节点 ${analysis.size.nodeId} · ${analysis.size.classType}`);
  if (!analysis.negative) analysis.lines.push('负面提示词 → 未接入（这类工作流通常不接受负面词）');
  return analysis;
}

/**
 * 占位符替换：先按整值匹配（可还原成数字），再做子串替换。
 * 返回被占位符占用的字段键，自动识别不会覆盖这些字段。
 */
function applyPlaceholders(graph: ComfyPromptGraph, values: ComfyInjection, applied: string[]): Set<ComfyFieldKey> {
  const handled = new Set<ComfyFieldKey>();
  const byToken = new Map(COMFY_PLACEHOLDERS.map(placeholder => [placeholder.token, placeholder]));
  const valueOf = (key: ComfyFieldKey): string | number => {
    switch (key) {
      case 'prompt': return values.positive;
      case 'negative': return values.negative;
      case 'steps': return values.steps;
      case 'cfg': return values.cfg;
      case 'seed': return values.seed;
      case 'sampler': return values.sampler;
      case 'scheduler': return values.scheduler;
      case 'width': return values.width;
      case 'height': return values.height;
      case 'batch': return values.batch;
    }
  };
  const replace = (text: string): string | number | null => {
    const exact = byToken.get(text);
    if (exact) {
      const value = valueOf(exact.key);
      // 文本占位符写进空值时保留空串，避免 ComfyUI 收到 "undefined"。
      handled.add(exact.key);
      applied.push(`${exact.label}（占位符 ${exact.token}）`);
      return value;
    }
    let result = text;
    let touched : ComfyFieldKey | null = null;
    let touchedToken = '';
    for (const placeholder of COMFY_PLACEHOLDERS) {
      if (!result.includes(placeholder.token)) continue;
      touched = placeholder.key;
      touchedToken = placeholder.token;
      result = result.split(placeholder.token).join(String(valueOf(placeholder.key)));
    }
    if (!touched) return null;
    handled.add(touched);
    applied.push(`${byToken.get(touchedToken)?.label ?? touched}（占位符 ${touchedToken}）`);
    return result;
  };
  const walk = (node: ComfyWorkflowNode): void => {
    for (const [key, raw] of Object.entries(node.inputs)) {
      if (typeof raw !== 'string') continue;
      const replaced = replace(raw);
      if (replaced !== null) node.inputs[key] = replaced;
    }
  };
  for (const node of Object.values(graph)) walk(node);
  return handled;
}

function setInput(graph: ComfyPromptGraph, nodeId: string, field: string, value: unknown): boolean {
  const node = graph[nodeId];
  if (!node || !Object.hasOwn(node.inputs, field)) return false;
  const current = node.inputs[field];
  const accepts = typeof value === 'number' ? typeof current === 'number' : typeof current === 'string';
  if (!accepts) return false;
  node.inputs[field] = value;
  return true;
}

interface ParamWrite {
  /** 与占位符共用的语义键；已被占位符占用的字段不再覆盖。 */
  semantic: ComfyFieldKey;
  /** 优先尝试的节点与字段。 */
  targets?: { nodeId: string; field: string }[];
  /** 全局兜底时按顺序尝试的字段名。 */
  fields: string[];
  value: string | number;
  label: string;
}

/** 先写采样器，再按字段名退到拆分式工作流（SamplerCustom / RandomNoise / BasicScheduler）。 */
function writeParam(graph: ComfyPromptGraph, handled: Set<ComfyFieldKey>, applied: string[], write: ParamWrite): void {
  if (handled.has(write.semantic)) return;
  for (const target of write.targets ?? []) {
    if (setInput(graph, target.nodeId, target.field, write.value)) {
      applied.push(`${write.label} → 节点 ${target.nodeId}`);
      return;
    }
  }
  for (const field of write.fields) {
    for (const [nodeId, node] of Object.entries(graph)) {
      if (setInput(graph, nodeId, field, write.value)) {
        applied.push(`${write.label} → 节点 ${nodeId} · ${node.class_type}`);
        return;
      }
    }
  }
}

function writeText(graph: ComfyPromptGraph, target: ComfyTarget | undefined, text: string): number {
  if (!target) return 0;
  let written = 0;
  for (const field of target.fields) {
    if (setInput(graph, target.nodeId, field, text)) written++;
  }
  return written;
}

/** 把一次生图的参数写进工作流，返回可直接提交给 /prompt 的图。 */
export function buildComfyPrompt(source: string, values: ComfyInjection): ComfyBuildResult {
  const graph = parseComfyWorkflow(source);
  const analysis = analyseComfyWorkflow(graph);
  const applied: string[] = [];
  const warnings = [...analysis.warnings];

  // 1. 占位符优先，占住的字段不再被自动识别改写。
  const handled = applyPlaceholders(graph, values, applied);

  // 2. 提示词走连线追溯。
  if (!handled.has('prompt')) {
    const written = writeText(graph, analysis.positive, values.positive);
    if (written) applied.push(`正面提示词 → 节点 ${analysis.positive!.nodeId}`);
    else warnings.push('没有找到正面提示词节点，工作流可能需要改用占位符 %prompt%。');
  }
  if (!handled.has('negative')) {
    if (values.negative.trim()) {
      if (writeText(graph, analysis.negative, values.negative)) applied.push(`负面提示词 → 节点 ${analysis.negative!.nodeId}`);
      else warnings.push('该工作流没有可写入的负面提示词节点，本次负面词已忽略。');
    } else if (analysis.negative) {
      writeText(graph, analysis.negative, '');
    }
  }

  // 3. 采样参数：先认采样器节点，再按字段名兜底。
  const seedField = analysis.sampler?.seedField || 'seed';
  const samplerTarget = (field: string) => analysis.sampler
    ? [{ nodeId: analysis.sampler.nodeId, field }] : [];
  writeParam(graph, handled, applied, { semantic: 'steps', targets: samplerTarget('steps'), fields: ['steps'], value: values.steps, label: `步数 ${values.steps}` });
  writeParam(graph, handled, applied, { semantic: 'cfg', targets: samplerTarget('cfg'), fields: ['cfg'], value: values.cfg, label: `CFG ${values.cfg}` });
  writeParam(graph, handled, applied, { semantic: 'seed', targets: samplerTarget(seedField), fields: [seedField, 'seed', 'noise_seed'], value: values.seed, label: `种子 ${values.seed}` });
  if (values.sampler.trim()) {
    writeParam(graph, handled, applied, {
      semantic: 'sampler', targets: samplerTarget('sampler_name'), fields: ['sampler_name'],
      value: values.sampler.trim(), label: `采样器 ${values.sampler.trim()}`,
    });
  }
  if (values.scheduler.trim()) {
    writeParam(graph, handled, applied, {
      semantic: 'scheduler', targets: samplerTarget('scheduler'), fields: ['scheduler'],
      value: values.scheduler.trim(), label: `调度器 ${values.scheduler.trim()}`,
    });
  }

  // 4. 画幅与批量张数：先认采样器上连的画幅节点，没有再全图找第一个带宽高的节点。
  const sizeNode = analysis.size ?? Object.entries(graph)
    .map(([nodeId, node]) => ({ nodeId, node }))
    .filter(entry => typeof entry.node.inputs.width === 'number' && typeof entry.node.inputs.height === 'number')
    .map(entry => ({
      nodeId: entry.nodeId, classType: entry.node.class_type,
      batchField: typeof entry.node.inputs.batch_size === 'number' ? 'batch_size' : '',
    }))[0];
  if (!handled.has('width') || !handled.has('height')) {
    if (sizeNode) {
      const widthOk = handled.has('width') || setInput(graph, sizeNode.nodeId, 'width', values.width);
      const heightOk = handled.has('height') || setInput(graph, sizeNode.nodeId, 'height', values.height);
      if (widthOk && heightOk) applied.push(`画幅 ${values.width}×${values.height} → 节点 ${sizeNode.nodeId}`);
      else warnings.push('画幅字段类型不匹配，宽高沿用工作流设置。');
    } else warnings.push('没有找到画幅字段，宽高沿用工作流设置。');
  }
  if (!handled.has('batch') && sizeNode?.batchField) {
    const batch = Math.max(1, Math.floor(values.batch));
    if (setInput(graph, sizeNode.nodeId, sizeNode.batchField, batch)) {
      applied.push(`单批 ${batch} 张 → 节点 ${sizeNode.nodeId}`);
    }
  }

  if (!applied.some(item => item.startsWith('正面提示词') || item.startsWith('负面提示词'))) {
    fail('未能在工作流里找到提示词写入点。请在文本编码器的 text 里写 "%prompt%" 后重试。');
  }
  return { prompt: graph, applied, warnings, analysis };
}

/** 面板上的「校验工作流」：只读分析，不改动任何内容。 */
export function describeComfyWorkflow(source: string): { lines: string[]; warnings: string[]; placeholders: string[]; nodes: number } {
  const graph = parseComfyWorkflow(source);
  const analysis = analyseComfyWorkflow(graph);
  const lines = [...analysis.lines];
  if (analysis.placeholders.length) lines.unshift(`占位符 → 检测到 ${analysis.placeholders.join('、')}`);
  else lines.push('占位符 → 未使用（走自动识别）');
  return { lines, warnings: analysis.warnings, placeholders: analysis.placeholders, nodes: Object.keys(graph).length };
}
