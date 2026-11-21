import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { installSkillDocumentView } from './skill-documents-ui.mjs';

// Exact pinned-rc5 edits fail closed rather than silently exposing generic file views.
export function patchSkillCards(nm) {
  const marker = '// greenroom-skill-cards-v1';
  function patch(pkg, replacements, prefix = '', entry = 'client.js') {
    const file = join(nm, '@deepseek-ai', pkg, 'lib', entry);
    let source = readFileSync(file, 'utf8');
    if (source.includes(marker)) return;
    for (const [before, after] of replacements) {
      if (!source.includes(before)) throw new Error(`Skill/card patch target changed: ${pkg}: ${before.slice(0, 80)}`);
      source = source.replace(before, after);
    }
    writeFileSync(file, marker + '\n' + prefix + source);
  }
  const controller = join(nm, '@deepseek-ai/dsh-api-session-controller/lib/index.js');
  let server = readFileSync(controller, 'utf8');
  if (!server.includes(marker)) {
    const pathField = '...skill.path === void 0 ? {} : { path: skill.path },';
    if (!server.includes(pathField)) throw new Error('Skill list path projection changed');
    writeFileSync(controller, marker + '\n' + server.replace(pathField, '/* Managed Skill documents never expose host paths. */'));
  }
  patch('dsh-client-ui-skill', [
    ['`sidebarRight`,`uiConversation`', '`sidebarRight`,`sidebarRightTabs`,`uiConversation`'],
    ['function apply(ctx){', 'function apply(ctx){const openDocumentation = installSkillDocumentView(ctx, react, react_jsx_runtime.jsx);'],
    ['name:`tool.call.toolview`,key:`skill`,locale:NS', 'name:`tool.call.toolview`,key:`skill`,inject:(sessionId)=>({openDocumentation:(name)=>openDocumentation(sessionId,name)}),locale:NS'],
    ['function StartedSkillRow({block,inspect,t}){', 'function StartedSkillRow({block,inspect,t,openDocumentation}){'],
    ['children:[(0,react_jsx_runtime.jsxs)(`section`,{className:SkillRow_module_css_default.instructionsCard,', 'children:[(0,react_jsx_runtime.jsx)(`button`,{type:`button`,onClick:()=>openDocumentation(model.name),children:`查看说明`}),(0,react_jsx_runtime.jsxs)(`section`,{className:SkillRow_module_css_default.instructionsCard,'],
    ['const path=catalog.find(skill=>`/${skill.name}`===ref)?.path;if(path===void 0)return false;ctx.sidebarRight.openResource(fileAddressFor(session.sessionId,cwd,path));return true', 'const skill=catalog.find(skill=>`/${skill.name}`===ref);return skill?openDocumentation(session.sessionId,skill.name):false'],
  ], installSkillDocumentView.toString() + '\n');
  // A model-supplied positive timeout must never resume a managed decision.
  // Preserve native call ownership/cancellation while always awaiting explicit submission.
  patch('dsh-tool-ask-user', [
    ['const timeout = validateTimeout(args.timeout ?? defaultTimeout);', 'const timeout = -1; // Greenroom requires explicit submission; model timeout cannot bypass it.'],
    ['description: `Wait seconds for the entire batch (default ${defaultTimeout}); omit unless the user specifies a duration. Use -1 only when an answer is required before proceeding.`', 'description: "Greenroom always waits for explicit user submission. This parameter cannot shorten the wait."'],
  ], '', 'index.js');
  patch('dsh-client-ui-user-questions', [
    // The native UI preselects a recommended first option. Managed decisions must start empty.
    ['selected:answer!==void 0?[...answer.selected]:review===void 0?recommendedOptions(item):[],', 'selected:answer!==void 0?[...answer.selected]:[],'],
    ['const locked=busy!==null||review!==void 0;', 'const locked=busy!==null||review!==void 0||!canSubmit;'],
  ]);
}
