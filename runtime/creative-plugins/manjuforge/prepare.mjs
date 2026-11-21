import { readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { prepareKnowledge } from '../aigc-shared/prepare.mjs';

const root = resolve(process.argv[2] || '.');
await prepareKnowledge({ root, id: 'manjuforge', prefix: 'manjuforge', skillFiles: ['SKILL.md'],
  productionKinds: ['image', 'video', 'tts', 'music'],
  notes: `- 本套件保留七个原生记忆文件：角色档案.md、世界观.md、场景布局.md、剧情摘要.md、伏笔表.md、故事圣经.md、角色关系图.md；通过对应文档 key 保存。分集完整版使用 document=episode 与 episode=集数。\n- 原质量检查器仅通过 manjuforge_quality_check 和 manjuforge_consistency_check 运行。它们读取当前成员工程，不读 demo、不运行 selftest 或维护发布流程。\n- 保留 references/adapter-contract.md：当前 job 只含一种模态，sourceEntry 必须是当前已接受文档的二级标题，prompt 必须完整复制自该标题；每个真实参考图通过 referenceAssetIds 和 referenceBindings 的 REF- 槽位、顺序、名称、用途、允许/禁止控制范围绑定。PLAN- 占位不能进入生产。\n- 模型由管理员托管档映射；确认当前 job 后才执行，执行前消费一次确认。成功、失败或结果未知后的重试均须新建 job、重新展示并取得新确认。` });
// A role heading ends at its line; the upstream negated class also matched newlines.
const consistencyPath = join(root, 'scripts/consistency_check.py');
await writeFile(consistencyPath, (await readFile(consistencyPath, 'utf8'))
  .replace('([^（(]+)', '([^\\n（(]+)'));
const retained = new Set(['SKILL.md', 'references', 'templates', 'scripts', 'LICENSE']);
for (const entry of await readdir(root)) {
  if (!retained.has(entry)) await rm(join(root, entry), { recursive: true, force: true });
}
for (const entry of await readdir(join(root, 'scripts'))) {
  if (!['quality_check.py', 'consistency_check.py'].includes(entry)) await rm(join(root, 'scripts', entry), { recursive: true, force: true });
}
