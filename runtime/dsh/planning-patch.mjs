import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Goal remains the official same-session domain/CAS. This deployment uses it
// as a stage tracker, never as permission to enqueue autonomous model rounds.
export function patchPlanningRuntime(nm) {
  const marker = '// greenroom-stage-goals-v1';
  const patch = (pkg, file, replacements) => {
    const path = join(nm, '@deepseek-ai', pkg, 'lib', file);
    let text = readFileSync(path, 'utf8');
    if (text.includes(marker)) return;
    for (const [before, after] of replacements) {
      if (!text.includes(before)) throw new Error(`Planning patch target changed: ${pkg}/${file}: ${before.slice(0, 60)}`);
      text = text.replace(before, after);
    }
    writeFileSync(path, marker + '\n' + text);
  };
  patch('dsh-goal', 'index.js', [
    ['return this.commitSnapshot(agent, runtime, "create", goal, 0, now, now, "armed");',
     'return this.commitSnapshot(agent, runtime, "create", goal, 0, now, now, "disarmed");'],
    ['return this.commitCurrent(agent, currentState, runtime, "resume", this.withPhase(current, "active"), "armed");',
     'return this.commitCurrent(agent, currentState, runtime, "resume", this.withPhase(current, "active"), "disarmed");'],
  ]);
  patch('dsh-tool-goal', 'index.js', [
    ['const CREATE_DESCRIPTION = "Create a persisted goal that keeps this session working across automatic continuation rounds. Use it when the direct human request is a long-running objective, even if the user did not say \\"goal\\"; not for single-turn work.";',
     'const CREATE_DESCRIPTION = "Record a stage objective for this session. This tracker does not run automatic continuation rounds or authorize new work; continue only in the current user-requested turn.";'],
    ['return `create_goal may infer goal intent from a direct human request in any language. After session resume or fork, an active goal is disarmed: when a human asks to continue or resume in any wording or language, use update_goal action resume to rearm it. Mark complete only when the objective is actually achieved. Mark blocked only after the same blocking condition persists for at least ${blockedAfter} consecutive goal rounds, and report that concrete condition in blocked_reason; difficulty, uncertainty, or useful remaining work is not blocked.`;',
     'return "Goals are session stage metadata, not automatic execution. Creating, resuming or restoring a goal never arms continuation. Mark complete only after the objective is achieved; report a concrete unresolved dependency when blocked. Work only within the current user request.";'],
    ['Optional positive safe-integer limit on automatic continuation rounds.', 'Stored positive round limit; this stage tracker never executes automatic rounds.'],
    ['edit, pause, and resume require a direct top-level human request. complete and blocked are also allowed during an automatic continuation of this goal; blocked is rejected before the configured minimum round count.', 'edit, pause, resume, complete and blocked require a direct top-level human request. This tracker never starts automatic continuation rounds.'],
    ['Required only with action blocked: the concrete condition that persisted across rounds and blocks progress.', 'Required only with action blocked: the concrete unresolved condition blocking this stage.'],
  ]);
  patch('dsh-command-goal', 'index.js', [
    ['"Set or view the goal for a long-running task"', '"记录或查看阶段目标（不会自动继续执行）"'],
    ['`Activation: ${goal.activation}`', '"Execution: manual conversation only; no automatic continuation"'],
  ]);
  patch('dsh-client-ui-goal', 'client.js', [
    ['"phase.active.disarmed":`待继续的目标`', '"phase.active.disarmed":`阶段目标（不会自动执行）`'],
    ['"phase.active.disarmed":`Inactive Goal`', '"phase.active.disarmed":`Stage goal (no automatic execution)`'],
    ['const resume=goal.phase!==`active`||activation===`disarmed`;', 'const resume=goal.phase===`paused`;'],
    ['(0,react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Tooltip,{portal:true,label:toggleLabel,', 'goal.phase!==`blocked`&&(0,react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Tooltip,{portal:true,label:toggleLabel,'],
    ['disabled:pending||!resume&&activation===void 0,onClick:()=>{runAction(resume?onResume:onPause)}', 'disabled:pending||goal.phase===`blocked`,onClick:()=>{runAction(resume?onResume:onPause)}'],
  ]);
  patch('dsh-client-ui-plan', 'client.js', [
    ['"chip.on.title":`计划模式已开启 — 点击关闭（/plan off）`', '"chip.on.title":`计划模式已开启；点击离开不代表批准计划（/plan off）`'],
    ['"chip.on.title":`Plan mode on — click to turn off (/plan off)`', '"chip.on.title":`Leave plan mode, without approving a plan (/plan off)`'],
  ]);
  patch('dsh-plan-mode', 'index.js', [
    ['text: "Plan mode off."', 'text: "已离开计划模式；这不表示任何计划已获批准。"'],
    ['text: "Leaving plan mode (applies from the next step)."', 'text: "将在下一步离开计划模式；这不表示任何计划已获批准。"'],
    ['text: "Leaving plan mode (applies from the next step)."', 'text: "将在下一步离开计划模式；这不表示任何计划已获批准。"'],
  ]);
}
