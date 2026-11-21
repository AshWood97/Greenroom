import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

async function skills(root, prefix = '') {
  const found = [];
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    const name = prefix ? prefix + '/' + entry.name : entry.name;
    if (entry.isDirectory()) found.push(...await skills(root, name));
    else if (entry.isFile() && entry.name === 'SKILL.md') found.push(name);
  }
  return found;
}

/** Inject the managed execution boundary while preserving upstream knowledge. */
export async function prepareKnowledge({ root, id, prefix, skillFiles, notes = '', patch, productionKinds }) {
  root = resolve(root);
  if (patch) await patch(root);
  for (const name of skillFiles || await skills(root)) {
    const path = join(root, name);
    let source = await readFile(path, 'utf8');
    const startMarker = '<!-- greenroom-managed-aigc -->';
    const endMarker = '<!-- /greenroom-managed-aigc -->';
    const previous = source.indexOf(startMarker);
    if (previous >= 0) {
      let end = source.indexOf(endMarker, previous);
      if (end >= 0) end += endMarker.length;
      else {
        const tail = notes.trim() || `- 交付使用 ${prefix}_archive_project；不额外运行 hash、checksum、签名、发布、自测或上游维护流程。`;
        end = source.indexOf(tail, previous);
        if (end < 0) throw new Error('原受管说明无法定位，请使用固定上游原稿重新准备：' + name);
        end += tail.length;
      }
      source = source.slice(0, previous).replace(/\r?\n$/, '') + source.slice(end).replace(/^\r?\n(?:\r?\n)?/, '');
    }
    const frontmatter = source.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n/);
    const production = productionKinds?.length === 0
      ? '- 本套件只提供原生创作知识、文档编写和已注册的固定稿件工具；不提供生成服务。遇到需要外部生成平台的步骤时，明确说明当前执行通道不可用，保留创作规格供用户使用。\n'
      : `- 生产必须先 ${prefix}_prepare_production，向用户展示准确数量、提示词全文、模型、来源条目、参考绑定、参数、费用特征和输出；等待用户明确确认当前 jobId 后 ${prefix}_confirm_production，再 ${prefix}_execute_production。修改文档后旧确认失效；一次确认只消费一次，失败重试也必须准备并确认新任务。\n- 查询与刷新恢复只用 ${prefix}_get_production，沿原任务编号查询；查询或归档错误不重提生成。每一项提交与任务失败均保留真实的脱敏原因。\n`;
    const note = `\n${startMarker}\n## Greenroom 受管执行\n\n先调用 greenroom_select_plugins 选择 ${id}。保留本套件的原创作方法、引用和模板；以下规则覆盖上游终端、安装、个人供应商配置、网络请求与发布命令。\n\n- 镜像知识目录只读；按需调用 mcp__greenroom__${prefix}_read_knowledge。成员文档使用 ${prefix}_create_project、${prefix}_read_document 和 ${prefix}_write_document，原生目录和数据格式在私有工程内保存。\n- 只能用 ${prefix}_import_asset 导入当前成员已有资产；不能把上游示例、PLAN- 占位或任意本地路径当作真实参考素材。\n- 固定脚本只能通过本套件列出的业务 MCP 执行；不使用终端、不在 DSH 或审阅服务中执行成员文件中的代码、不安装额外 Skill、不配置个人 API Key。已注册的代码制片能力须在用户确认后经明确隔离的渲染 Job 执行。管理员托管模型与生成服务通过平台调用。\n${production}- 交付使用 ${prefix}_archive_project；不额外运行 hash、checksum、签名、发布、自测或上游维护流程。\n${notes ? '\n' + notes.trim() + '\n' : ''}\n${endMarker}\n\n`;
    await writeFile(path, frontmatter ? frontmatter[0] + note + source.slice(frontmatter[0].length) : note + source, 'utf8');
  }
}
