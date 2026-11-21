import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { prepareKnowledge } from '../aigc-shared/prepare.mjs';

await prepareKnowledge({
  root: process.argv[2], productionKinds: [], id: 'director-skills', prefix: 'director_skills',
  skillFiles: ['action-fight-prompt', 'cinematic-asset-prompts', 'emotion-performance-director', 'miora-video-studio', 'seedance-motion-studio', 'travel-photo-to-video', 'travel-skill'].map((name) => name + '/SKILL.md'),
  notes: `保留七个Skill各自的方法、引用与创意/素材/试镜/成片确认点。旅行脚本只通过 mcp__greenroom__director_skills_lint_travel_prompt、validate_travel_timeline、lint_travel_manifest、build_travel_packet 四个固定业务工具运行；项目文件通过read_document/write_document，不接受命令或脚本路径。镜头清单沿用原JSON兼容YAML。Miora真实WorkBuddy工具尚未接入，先调用mcp__greenroom__director_skills_miora_status；仅能编写与诊断，不执行Miora生成/轮询/画布写入，不运行miora_watch.py，不读取用户主目录或以其它生视频通道冒充。所有任务归属以当前成员项目绑定的任务ID和产物ID为准，禁止按时间扫描成片或运行文件摘要对账。`,
  async patch(root) {
    const path = join(root, 'miora-video-studio/SKILL.md');
    let source = await readFile(path, 'utf8');
    source = source.replace(/^- 仍存疑时\*\*用返回值里的 `signedUrl` 做指纹对账\*\*：[^\n]*/m, '- 产物必须绑定当前成员项目的上游任务ID及平台资产ID；绑定不明时保持待确认，不下载候选文件进行摘要比较。')
      .replace('只能靠提交时刻 + 指纹归属', '必须依靠当前成员项目保存的上游任务ID与产物ID绑定')
      .replace(/要下载返回值里的 `signedUrl` 做指纹对账时，用 Python `urllib.request`；/, '产物只能沿当前项目任务绑定读取；');
    await writeFile(path, source);
    const watcher = join(root, 'miora-video-studio/scripts/miora_watch.py');
    const code = (await readFile(watcher, 'utf8')).replace('存疑时下载返回的 signedUrl 做 md5 与本地文件比对，能唯一确定归属。', '平台按成员项目的上游任务ID与产物ID绑定归属，不扫描本机目录，不计算文件摘要。');
    await writeFile(watcher, code);
  },
});
