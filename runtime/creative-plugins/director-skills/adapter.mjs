import { join } from 'node:path';
import { createSuiteAdapter } from '../aigc-shared/adapter.mjs';

const id = 'director-skills';
const prefix = 'director_skills';
const knowledgeRoot = '/opt/creative-skills/' + id;
const projectId = { type: 'string', description: '当前成员项目ID。' };
const schema = (properties = {}, required = []) => ({ type: 'object', additionalProperties: false, properties: { projectId, ...properties }, required: ['projectId', ...required] });
const file = (api, args, name) => join(api.projectPath(args.projectId), name);
const documents = {
  brief: '00-project-brief.md', assets: '01-asset-register.csv', reference: '02-visual-reference.md', storyboard: '03-storyboard.md',
  manifest: '04-shot-manifest.yaml', prompts: '05-generation-prompts.md', generation_log: '06-generation-log.csv', qc: '07-qc-report.md',
  travel_prompt: 'travel-prompt.txt', treatment: 'treatment.md', beat_sheet: 'beat-sheet.csv', shot_list: 'shot-list.csv',
  research: 'research-dossier.md', claims: 'claims-register.csv', directions: 'creative-directions.md', visual_bible: 'visual-bible.md',
  continuity: 'continuity-bible.md', prompt_card: 'prompt-card.md', edit_list: 'edit-decision-list.md', pilot: 'pilot-review.md',
  delivery: 'delivery-checklist.md', action: 'action-fight-prompt.md', performance: 'emotion-performance.md', asset_prompts: 'cinematic-asset-prompts.md',
  miora_request: 'miora-request.md', miora_diagnosis: 'miora-diagnosis.md',
};
const scripts = {
  lint_travel_prompt: {
    file: 'travel-skill/scripts/lint_prompt.py', runtime: 'python3', description: '按原旅行Skill规则检查当前项目提示词，不调用生成。',
    inputSchema: schema({ model: { type: 'string', enum: ['seedance', 'kling', 'midjourney', 'unspecified'] }, maxChars: { type: 'integer', minimum: 0 } }),
    args: (args, api) => [file(api, args, documents.travel_prompt), '--model', args.model || 'unspecified', '--max-chars', String(args.maxChars || 0)],
  },
  validate_travel_timeline: {
    file: 'travel-skill/scripts/validate_timeline.py', runtime: 'python3', description: '运行原旅行分镜时间线规则，保持镜号及未授权内容。',
    inputSchema: schema({ maxShotSeconds: { type: 'number', minimum: 0 }, expectedTotal: { type: 'number', minimum: 0 } }),
    args: (args, api) => [file(api, args, documents.storyboard), '--max-shot-seconds', String(args.maxShotSeconds || 0), '--expected-total', String(args.expectedTotal || 0)],
  },
  lint_travel_manifest: {
    file: 'travel-skill/scripts/lint_shot_manifest.py', runtime: 'python3', description: '检查原旅行镜头清单和首帧空间字段。', inputSchema: schema(),
    args: (args, api) => [file(api, args, documents.manifest)],
  },
  build_travel_packet: {
    file: 'travel-skill/scripts/build_generation_packet.py', runtime: 'python3', outputDocuments: ['prompts'], description: '从原JSON兼容YAML镜头清单编译逐镜生成包，固定写入项目05-generation-prompts.md。', inputSchema: schema(),
    args: (args, api) => [file(api, args, documents.manifest), '--output', file(api, args, documents.prompts)],
  },
};

export async function createAdapter(ctx) {
  return createSuiteAdapter(ctx, {
    id, prefix, knowledgeRoot, documents, scripts, productionKinds: [],
    knowledgeFiles: ['product-introduction', 'news-explainer', 'science-explainer', 'brand-promo']
      .map(name => 'seedance-motion-studio/modules/' + name + '.md'),
    extraTools: [{ name: prefix + '_miora_status', description: '报告Miora真实WorkBuddy执行通道的接入状态。当前不可执行，只支持保留原方法编写和诊断。',
      inputSchema: { type: 'object', additionalProperties: false, properties: {} } }],
    handlers: { miora_status: async () => ({ status: 'unavailable', capability: 'Miora / WorkBuddy',
      message: '平台未接入真实WorkBuddy的Miora工具，不能执行Miora生成、轮询或画布写入。可按原Skill整理规格、提示词和诊断；不会改用其他生成通道冒充。',
      ownership: '恢复真实通道后，只沿成员项目绑定的上游任务ID和对应产物读取结果，不扫描共享目录或计算文件摘要。' }) },
  });
}
