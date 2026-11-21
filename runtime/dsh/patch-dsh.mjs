#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installGreenroom } from './greenroom-client.mjs';
import { MANAGED_TOOLS } from './greenroom-managed.mjs';
import { CREATIVE_CATALOG, displayPlugins } from './creative-catalog.mjs';
import { patchManagedRuntime } from './managed-patch.mjs';
import { installTrajectoryClient } from './trajectory-view.mjs';
import { patchSkillCards } from './skill-cards-patch.mjs';
import { patchSessionForkUI } from './session-fork-patch.mjs';
import { patchPlanningRuntime } from './planning-patch.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const nm = existsSync('/opt/dsh/node_modules')
  ? '/opt/dsh/node_modules'
  : join(__dirname, 'node_modules');

console.log(`[patch-dsh] Patching DSH at ${nm}...`);
const uiMarker = '// greenroom-ui-rc3-v1';
const native = process.env.GREENROOM_DSH_NATIVE === '1';
const plugins = displayPlugins();

function replaceRequired(content, before, after, label) {
  if (!content.includes(before)) throw new Error(`DSH ${label} patch target changed`);
  return content.replace(before, after);
}

// Use the member workspace directly instead of asking for a local directory.
const wsCtrlFile = join(nm, '@deepseek-ai/dsh-api-workspace-controller/lib/index.js');
if (existsSync(wsCtrlFile) && !readFileSync(wsCtrlFile, 'utf8').includes(uiMarker)) {
  let content = readFileSync(wsCtrlFile, 'utf8');
  const target = /async initializeDefault\(signal\) \{[\s\S]*?\n[ \t]+\}(?=\n\t\t\/\*\*)/;
  if (!target.test(content)) throw new Error('DSH default workspace patch target changed');
  content = content.replace(target, `async initializeDefault(signal) {
            signal.throwIfAborted();
            const path = process.env.DSH_DEFAULT_WORKSPACE || "/workspace";
            const workspace = await this.ctx.workspaceRegistry.resolveByPath(path)
              ?? await this.ctx.workspaceRegistry.create(path, "我的工作区");
            return { workspace: workspaceView(workspace) };
        }`);
  writeFileSync(wsCtrlFile, uiMarker + '\n' + content, 'utf8');
}

const convUiFile = join(nm, '@deepseek-ai/dsh-client-ui-conversation/lib/client.js');
if (existsSync(convUiFile) && !readFileSync(convUiFile, 'utf8').includes(uiMarker)) {
  let content = readFileSync(convUiFile, 'utf8');
  const replacements = [
    ...(!native ? [
      ['hero&&heroWorkspaceRow', 'false&&heroWorkspaceRow'],
      ['const inert=sessionId===void 0||hero&&chipTitle===void 0;', 'const inert=sessionId===void 0;'],
      ['.wSkVaW_heroWorkspaceRow{', '.wSkVaW_heroWorkspaceRow{display:none!important;'],
    ] : []),
    ['const interruptible=running&&(continuable||sending&&subagent===null);', 'const interruptible=running&&(continuable||sending&&subagent===null||(!primaryStops&&stopAction!==void 0));'],
    ['if(result!==void 0&&!result.ok)return{kind:`error`};', `if(result!==void 0&&!result.ok){
      const _err=result.error;
      const _reason=_err?.details?.reason;
      const _attachmentMessages={
        MODEL_DOES_NOT_SUPPORT_IMAGES:"当前模型不支持图片，请切换支持图片的模型",
        MODEL_IMAGE_CAPABILITY_UNKNOWN:"当前模型的图片能力尚未确认，请选择已确认支持图片的模型",
        FILE_NOT_STAGED:"附件尚未上传完成，请等待上传完成后发送",
        INVALID_IMAGE:"图片无法解码或已损坏",
        IMAGE_TYPE_MISMATCH:"图片内容与声明格式不一致",
        IMAGE_TOO_LARGE:"图片超出上传大小限制",
        IMAGES_TOO_LARGE:"图片总大小超出上传限制",
        TOO_MANY_IMAGES:"图片数量超出单次发送限制"
      };
      return {kind:"error",text:_attachmentMessages[_reason]||_err?.message||"发送失败"};
    }`],
    ['case`MODEL_DOES_NOT_SUPPORT_IMAGES`:return t(`image.modelUnsupported`);', 'case`MODEL_DOES_NOT_SUPPORT_IMAGES`:return t(`image.modelUnsupported`);case`MODEL_IMAGE_CAPABILITY_UNKNOWN`:return "当前模型的图片能力尚未确认，请选择已确认支持图片的模型";'],
    ['const notice=useNotices(s=>s);', 'const notice=useNotices(s=>s);const [dismissedError,setDismissedError]=(0,react.useState)(null);'],
    ['const imageLimits=useProjection(`imageLimits`);', `const imageLimits=useProjection(\`imageLimits\`);
      const persistentError=notice?.level==="error"?notice:promptError;
      const persistentErrorText=notice?.level==="error"?notice.text:promptError===null?"":promptError.error.code==="session/attachment-invalid"||promptError.error.code==="subagent/attachment-invalid"?attachmentErrorText(t,promptError.error.details?.reason,imageLimits):promptError.error.message;`],
    ['notice?.level===`info`&&(0,react_jsx_runtime.jsx)(`div`,{', `persistentError!==null&&persistentError!==dismissedError&&(0,react_jsx_runtime.jsxs)("div",{
      className:InputBar_module_css_default.notice,role:"alert","aria-live":"assertive",
      style:{display:"flex",alignItems:"flex-start",gap:"8px",border:"1px solid var(--dsw-alias-state-error-primary, #d75b5b)",background:"var(--dsw-alias-state-error-bg, rgba(220,70,70,.12))"},
      children:[(0,react_jsx_runtime.jsx)("span",{style:{flex:1},children:persistentErrorText}),(0,react_jsx_runtime.jsx)("button",{type:"button","aria-label":"关闭错误提示",onClick:()=>setDismissedError(persistentError),style:{flexShrink:0,border:0,background:"transparent",color:"inherit",cursor:"pointer",padding:"0 4px",lineHeight:"18px"},children:"关闭"})]
    }),notice?.level===\`info\`&&(0,react_jsx_runtime.jsx)(\`div\`,{`],
  ];
  for (const [before, after] of replacements) content = replaceRequired(content, before, after, 'conversation');
  content = content.replaceAll('error.details.reason', 'error.details?.reason');
  writeFileSync(convUiFile, uiMarker + '\n' + content, 'utf8');
}

// The workspace list is presented as groups without exposing a directory picker.
const wsUiFile = join(nm, '@deepseek-ai/dsh-client-ui-workspace/lib/client.js');
if (!native && existsSync(wsUiFile) && !readFileSync(wsUiFile, 'utf8').includes(uiMarker)) {
  let content = readFileSync(wsUiFile, 'utf8');
  const replacements = [
    ['directoryFlowAvailable&&(0,react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Tooltip', '(0,react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Tooltip'],
    ['onClick:()=>{requestAddWorkspace()}', `onClick:async()=>{
      try {
        const res=await createWorkspace({path:"/workspace"});
        if(res?.workspaceId) actions.setGroupExpanded(res.workspaceId,true);
      } catch(e) { console.error("创建分组失败",e); }
    }`],
    ['const blank=sessions.ids.find(id=>{const summary=sessions.byId[id];const listed=summary?.projectionValues?.agentPreset;return summary!==void 0&&summary.blank&&summary.cwd===workspace.path&&workspace.sessionIds.includes(id)&&!archived.includes(id)&&(options.agentPreset===void 0||typeof listed!==`string`||listed===options.agentPreset)});', 'const blank=void 0;'],
    ['"workspace.add":`添加工作区`', '"workspace.add":`新建分组`'],
    ['"delete.workspace":`删除工作区`', '"delete.workspace":`删除分组`'],
    ['"delete.desc":`将把“{name}”从工作区列表中移除。文件夹与会话记录会保留，其会话将显示在“未分组”下。`', '"delete.desc":`将把“{name}”从分组列表中移除。会话记录会保留，其会话将显示在“未分组”下。`'],
    ['"delete.pending":`正在删除工作区…`', '"delete.pending":`正在删除分组…`'],
    ['"rename.workspace.title":`重命名工作区`', '"rename.workspace.title":`重命名分组`'],
    ['"field.workspaceName":`工作区名称`', '"field.workspaceName":`分组名称`'],
    ['"conflict.named":`已存在名为“{name}”的工作区。`', '"conflict.named":`已存在名为“{name}”的分组。`'],
    ['"workspace.add":`Add workspace`', '"workspace.add":`New group`'],
    ['"delete.workspace":`Delete workspace`', '"delete.workspace":`Delete group`'],
    ['"rename.workspace.title":`Rename workspace`', '"rename.workspace.title":`Rename group`'],
    ['"field.workspaceName":`Workspace name`', '"field.workspaceName":`Group name`'],
  ];
  for (const [before, after] of replacements) content = replaceRequired(content, before, after, 'workspace');
  writeFileSync(wsUiFile, uiMarker + '\n' + content, 'utf8');
}

// Plugin pages use the remaining frame width with the sidebar collapsed.
const layoutFile = join(nm, '@deepseek-ai/dsh-client-ui-layout/lib/client.js');
if (existsSync(layoutFile) && !readFileSync(layoutFile, 'utf8').includes(uiMarker)) {
  let content = readFileSync(layoutFile, 'utf8');
  const replacements = [
    ['const RIGHTBAR_MAX_RATIO=.7;', 'const RIGHTBAR_MAX_RATIO=1;'],
    ['rightbar:null,', 'rightbar:null,rightbarInset:null,'],
    ['const rightbarPreference=layoutInfo.rightbar??viewport*.45;', 'const rightbarPreference=layoutInfo.rightbarInset===null?(layoutInfo.rightbar??Math.max(300,viewport-(sidebarPreference===0?56:sidebarPreference)-400)):Math.max(300,viewport-layoutInfo.rightbarInset);'],
    ['d.layoutInfo.rightbar=clampWidth(px,300,Math.max(300,d.layoutInfo.viewportWidth*RIGHTBAR_MAX_RATIO))', `const minLeftWidth=(d.layoutInfo.sidebar===0?56:clampWidth(d.layoutInfo.sidebar,264,420))+400;
      const maxRightWidth=Math.max(300,d.layoutInfo.viewportWidth-minLeftWidth);
      d.layoutInfo.rightbar=clampWidth(px,300,maxRightWidth);
      if(d.layoutInfo.rightbarInset!==null)d.layoutInfo.rightbarInset=d.layoutInfo.viewportWidth-d.layoutInfo.rightbar`],
    ['openRightbar:(d,track,fullscreen)=>{', `focusRightbar:d=>{
      d.layoutInfo.rightbarInstant=false;d.layoutInfo.rightbarFullscreen=false;d.layoutInfo.sidebar=0;d.layoutInfo.narrowExpanded=false;
      const inset=56+400;d.layoutInfo.rightbarInset=inset;d.layoutInfo.rightbar=Math.max(300,d.layoutInfo.viewportWidth-inset);
      d.layoutInfo.rightbarShown=true;d.layoutInfo.rightbarTrack=true;
    },openRightbar:(d,track,fullscreen)=>{`],
    ['openRightbar(track,fullscreen){', 'focusRightbar(){this.panels.focusRightbar()}openRightbar(track,fullscreen){'],
  ];
  for (const [before, after] of replacements) content = replaceRequired(content, before, after, 'layout');
  writeFileSync(layoutFile, uiMarker + '\n' + content, 'utf8');
}

const sidebarRightFile = join(nm, '@deepseek-ai/dsh-client-ui-sidebar-right/lib/client.js');
if (existsSync(sidebarRightFile) && !readFileSync(sidebarRightFile, 'utf8').includes(uiMarker)) {
  let content = readFileSync(sidebarRightFile, 'utf8');
  content = replaceRequired(content, 'autoFullscreen:()=>autoFullscreen,', 'focusRightbar:()=>layout.focusRightbar(),autoFullscreen:()=>autoFullscreen,', 'sidebar focus');
  content = replaceRequired(content,
    'this.place(sessionId,actions,{kind,contentId:address,title:definition.title(address)},address,options,options.params)}place(sessionId,actions,claim,address,placement,params){',
    `this.place(sessionId,actions,{kind,contentId:address,title:definition.title(address)},address,options,options.params);
      if(kind!==GUIDE_KIND&&this.mounted.getSnapshot()===sessionId){
        try { actions.setMode(sessionId,"push"); } catch (_) {}
        this.host.focusRightbar();
      }
    }place(sessionId,actions,claim,address,placement,params){`, 'sidebar tab');
  writeFileSync(sidebarRightFile, uiMarker + '\n' + content, 'utf8');
}

// Open the model list directly on the first click.
const modelSelectFile = join(nm, '@deepseek-ai/dsh-client-ui-model-selection/lib/client.js');
if (!native && existsSync(modelSelectFile) && !readFileSync(modelSelectFile, 'utf8').includes(uiMarker)) {
  let content = readFileSync(modelSelectFile, 'utf8');
  const replacements = [
    ['const[pane,setPane]=(0,react.useState)(`root`);', 'const[pane,setPane]=(0,react.useState)(`model`);'],
    ['setPane(currentChoice===void 0?`model`:`root`);', 'setPane(`model`);'],
    ['const close=(restoreFocus=false)=>{setOpen(false);setPane(`root`);', 'const close=(restoreFocus=false)=>{setOpen(false);setPane(`model`);'],
  ];
  for (const [before, after] of replacements) content = replaceRequired(content, before, after, 'model selection');
  const back = 'if(pane!==`root`&&currentChoice!==void 0)back(pane);else close(true);';
  if (!content.includes(back)) throw new Error('DSH model selection navigation patch target changed');
  content = content.replaceAll(back, 'close(true);');
  writeFileSync(modelSelectFile, uiMarker + '\n' + content, 'utf8');
}

// Extend the official UI's slot registration with Greenroom integrations.
const brandFile = join(nm, '@deepseek-ai/dsh-client-ui-brand-official/lib/client.js');
const brandContent = readFileSync(brandFile, 'utf8');
if (!brandContent.includes(uiMarker)) {
  const extension = `const installGreenroomSections = (() => {
    const react = require("react");
    const react_jsx_runtime = require("react/jsx-runtime");
    const feishuCss = \`
.greenroom-feishu-root {
	padding: 8px 16px 24px;
	color: var(--dsw-alias-label-primary, #ffffff);
	font-family: inherit;
}
.greenroom-feishu-header {
	margin-bottom: 20px;
}
.greenroom-feishu-title {
	font-size: 18px;
	font-weight: 600;
	margin: 0 0 6px 0;
	color: var(--dsw-alias-label-primary, #ffffff);
	display: flex;
	align-items: center;
	gap: 10px;
}
.greenroom-feishu-desc {
	font-size: 13px;
	color: var(--dsw-alias-label-tertiary, rgba(255, 255, 255, 0.6));
	line-height: 1.5;
	margin: 0;
}
.greenroom-feishu-card {
	background: var(--dsw-alias-bg-layer-1, rgba(255, 255, 255, 0.03));
	border: 1px solid var(--dsw-alias-border-l3, rgba(255, 255, 255, 0.08));
	border-radius: var(--dsw-radius-md, 10px);
	padding: 20px;
	margin-bottom: 16px;
}
.greenroom-feishu-status-row {
	display: flex;
	align-items: center;
	justify-content: space-between;
	margin-bottom: 16px;
}
.greenroom-feishu-badge {
	display: inline-flex;
	align-items: center;
	gap: 6px;
	padding: 4px 10px;
	border-radius: 9999px;
	font-size: 12px;
	font-weight: 500;
}
.greenroom-feishu-badge-success {
	background: rgba(16, 185, 129, 0.15);
	color: #10b981;
	border: 1px solid rgba(16, 185, 129, 0.3);
}
.greenroom-feishu-badge-muted {
	background: rgba(255, 255, 255, 0.06);
	color: rgba(255, 255, 255, 0.6);
	border: 1px solid rgba(255, 255, 255, 0.1);
}
.greenroom-feishu-badge-dot {
	width: 6px;
	height: 6px;
	border-radius: 50%;
	background: currentColor;
}
.greenroom-feishu-user-info {
	display: flex;
	flex-direction: column;
	gap: 10px;
	margin-bottom: 16px;
}
.greenroom-feishu-info-item {
	display: flex;
	font-size: 13px;
}
.greenroom-feishu-info-label {
	width: 90px;
	color: var(--dsw-alias-label-tertiary, rgba(255, 255, 255, 0.5));
}
.greenroom-feishu-info-value {
	color: var(--dsw-alias-label-primary, #ffffff);
	font-weight: 500;
}
.greenroom-feishu-scopes {
	display: flex;
	flex-wrap: wrap;
	gap: 6px;
	margin-top: 4px;
}
.greenroom-feishu-scope-tag {
	font-size: 11px;
	padding: 2px 8px;
	border-radius: 4px;
	background: rgba(255, 255, 255, 0.05);
	color: rgba(255, 255, 255, 0.7);
	border: 1px solid rgba(255, 255, 255, 0.08);
}
.greenroom-feishu-btn-primary {
	background: #10b981;
	color: #ffffff;
	border: none;
	border-radius: var(--dsw-radius-sm, 6px);
	padding: 8px 16px;
	font-size: 13px;
	font-weight: 500;
	cursor: pointer;
	display: inline-flex;
	align-items: center;
	gap: 6px;
	transition: background 0.15s;
}
.greenroom-feishu-btn-primary:hover {
	background: #059669;
}
.greenroom-feishu-btn-secondary {
	background: transparent;
	color: var(--dsw-alias-label-primary, #ffffff);
	border: 1px solid var(--dsw-alias-border-l3, rgba(255, 255, 255, 0.15));
	border-radius: var(--dsw-radius-sm, 6px);
	padding: 8px 16px;
	font-size: 13px;
	font-weight: 500;
	cursor: pointer;
	display: inline-flex;
	align-items: center;
	gap: 6px;
	transition: all 0.15s;
}
.greenroom-feishu-btn-secondary:hover {
	background: rgba(255, 255, 255, 0.06);
	border-color: rgba(255, 255, 255, 0.25);
}
.greenroom-feishu-btn-danger {
	background: transparent;
	color: #ef4444;
	border: 1px solid rgba(239, 68, 68, 0.3);
	border-radius: var(--dsw-radius-sm, 6px);
	padding: 7px 14px;
	font-size: 13px;
	font-weight: 500;
	cursor: pointer;
	display: inline-flex;
	align-items: center;
	gap: 6px;
	transition: all 0.15s;
}
.greenroom-feishu-btn-danger:hover {
	background: rgba(239, 68, 68, 0.1);
	border-color: #ef4444;
}
.greenroom-feishu-auth-box {
	background: rgba(16, 185, 129, 0.05);
	border: 1px dashed rgba(16, 185, 129, 0.3);
	border-radius: var(--dsw-radius-md, 8px);
	padding: 16px;
	margin: 16px 0;
	display: flex;
	flex-direction: column;
	gap: 12px;
}
.greenroom-feishu-code-display {
	display: flex;
	align-items: center;
	gap: 12px;
}
.greenroom-feishu-code {
	font-family: monospace;
	font-size: 20px;
	font-weight: 700;
	letter-spacing: 2px;
	color: #34d399;
	background: rgba(0, 0, 0, 0.3);
	padding: 6px 14px;
	border-radius: 6px;
	border: 1px solid rgba(16, 185, 129, 0.3);
}
.greenroom-feishu-alert {
	font-size: 13px;
	padding: 10px 14px;
	border-radius: 6px;
	margin-top: 12px;
}
.greenroom-feishu-alert-info {
	background: rgba(59, 130, 246, 0.1);
	color: #60a5fa;
	border: 1px solid rgba(59, 130, 246, 0.2);
}
.greenroom-feishu-alert-error {
	background: rgba(239, 68, 68, 0.1);
	color: #f87171;
	border: 1px solid rgba(239, 68, 68, 0.2);
}
\`;

		if (typeof document !== "undefined" && !document.querySelector("style[data-plugin-css='greenroom-feishu-cli']")) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "@greenroom/feishu-cli";
			tag.dataset.pluginCss = "greenroom-feishu-cli";
			tag.textContent = feishuCss;
			document.head.appendChild(tag);
		}

		function FeishuCliSection() {
			const [status, setStatus] = react.useState(null);
			const [loading, setLoading] = react.useState(true);
			const [authData, setAuthData] = react.useState(null);
			const [actionLoading, setActionLoading] = react.useState(false);
			const [errorMsg, setErrorMsg] = react.useState("");
			const [actionMsg, setActionMsg] = react.useState("");
			const [copied, setCopied] = react.useState(false);

			const fetchStatus = react.useCallback(async () => {
				setLoading(true);
				setErrorMsg("");
				try {
					const res = await fetch("/api/feishu/status", { credentials: "same-origin" });
					if (!res.ok) {
						const data = await res.json().catch(() => ({}));
						throw new Error(data.detail || "获取状态失败 (" + res.status + ")");
					}
					const data = await res.json();
					setStatus(data);
				} catch (err) {
					setErrorMsg(err.message || "请求失败");
				} finally {
					setLoading(false);
				}
			}, []);

			react.useEffect(() => {
				fetchStatus();
			}, [fetchStatus]);

			// Auto polling when device code is active
			react.useEffect(() => {
				if (!authData || !authData.user_code) return;
				let timer = null;
				let active = true;

				const checkPoll = async () => {
					try {
						const res = await fetch("/api/feishu/auth/poll", {
							method: "POST",
							headers: { "Content-Type": "application/json" },
							credentials: "same-origin"
						});
						if (res.ok) {
							const data = await res.json();
							if (data.status === "ready") {
								if (active) {
									setAuthData(null);
									setActionMsg("飞书账号授权成功！");
									fetchStatus();
								}
								return;
							}
						}
					} catch {}
					if (active) {
						timer = setTimeout(checkPoll, 3000);
					}
				};

				timer = setTimeout(checkPoll, 3000);
				return () => {
					active = false;
					if (timer) clearTimeout(timer);
				};
			}, [authData, fetchStatus]);

			const handleStartAuth = async () => {
				setErrorMsg("");
				setActionMsg("");
				setActionLoading(true);
				try {
					const res = await fetch("/api/feishu/auth/start", {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						credentials: "same-origin"
					});
					if (!res.ok) {
						const data = await res.json().catch(() => ({}));
						throw new Error(data.detail || "发起授权失败");
					}
					const data = await res.json();
					setAuthData(data);
					if (data.verification_url) {
						window.open(data.verification_url, "_blank");
					}
				} catch (err) {
					setErrorMsg(err.message || "发起授权失败");
				} finally {
					setActionLoading(false);
				}
			};

			const handleCheckPoll = async () => {
				setErrorMsg("");
				setActionMsg("");
				setActionLoading(true);
				try {
					const res = await fetch("/api/feishu/auth/poll", {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						credentials: "same-origin"
					});
					const data = await res.json();
					if (!res.ok) {
						throw new Error(data.detail || data.message || "检查失败");
					}
					if (data.status === "ready") {
						setAuthData(null);
						setActionMsg("飞书账号授权成功！");
						fetchStatus();
					} else {
						setActionMsg(data.message || "等待在飞书中确认授权...");
					}
				} catch (err) {
					setErrorMsg(err.message || "检查授权状态失败");
				} finally {
					setActionLoading(false);
				}
			};

			const handleLogout = async () => {
				if (!confirm("确定要退出飞书登录吗？退出后将清除该沙箱中的个人飞书凭据。")) return;
				setErrorMsg("");
				setActionMsg("");
				setActionLoading(true);
				try {
					const res = await fetch("/api/feishu/auth/logout", {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						credentials: "same-origin"
					});
					if (!res.ok) {
						const data = await res.json().catch(() => ({}));
						throw new Error(data.detail || "退出失败");
					}
					setAuthData(null);
					setActionMsg("已退出飞书账号");
					fetchStatus();
				} catch (err) {
					setErrorMsg(err.message || "退出登录失败");
				} finally {
					setActionLoading(false);
				}
			};

			const handleCopy = (text) => {
				navigator.clipboard?.writeText(text);
				setCopied(true);
				setTimeout(() => setCopied(false), 2000);
			};

			const isLoggedIn = status?.is_logged_in === true;
			const isAvailable = status?.available !== false;

			return (0, react_jsx_runtime.jsxs)("div", {
				className: "greenroom-feishu-root",
				children: [
					(0, react_jsx_runtime.jsxs)("div", {
						className: "greenroom-feishu-header",
						children: [
							(0, react_jsx_runtime.jsxs)("h2", {
								className: "greenroom-feishu-title",
								children: [
									(0, react_jsx_runtime.jsx)("span", { children: "飞书 CLI 账号授权" }),
									!loading && (0, react_jsx_runtime.jsxs)("span", {
										className: "greenroom-feishu-badge " + (isLoggedIn ? "greenroom-feishu-badge-success" : "greenroom-feishu-badge-muted"),
										children: [
											(0, react_jsx_runtime.jsx)("span", { className: "greenroom-feishu-badge-dot" }),
											isLoggedIn ? "已登录" : "未登录"
										]
									})
								]
							}),
							(0, react_jsx_runtime.jsx)("p", {
								className: "greenroom-feishu-desc",
								children: "连接您的飞书账号以启用智能体操作个人云文档、日历、任务与消息等协作工具。每位成员拥有独立加密的 CLI 沙箱与隔离凭据。"
							})
						]
					}),

					(0, react_jsx_runtime.jsxs)("div", {
						className: "greenroom-feishu-card",
						children: [
							loading ? (0, react_jsx_runtime.jsx)("div", {
								style: { color: "rgba(255, 255, 255, 0.6)", fontSize: "13px" },
								children: "正在查询飞书 CLI 状态..."
							}) : !isAvailable ? (0, react_jsx_runtime.jsxs)("div", {
								style: { color: "#f87171", fontSize: "13px" },
								children: ["⚠️ ", status?.message || "宿主机未检测到 lark-cli 运行环境，请联系管理员配置。"]
							}) : isLoggedIn ? (0, react_jsx_runtime.jsxs)("div", {
								children: [
									(0, react_jsx_runtime.jsxs)("div", {
										className: "greenroom-feishu-user-info",
										children: [
											(0, react_jsx_runtime.jsxs)("div", {
												className: "greenroom-feishu-info-item",
												children: [
													(0, react_jsx_runtime.jsx)("span", { className: "greenroom-feishu-info-label", children: "飞书用户" }),
													(0, react_jsx_runtime.jsx)("span", { className: "greenroom-feishu-info-value", children: status?.user?.userName || status?.user?.openId || "已授权用户" })
												]
											}),
											(0, react_jsx_runtime.jsxs)("div", {
												className: "greenroom-feishu-info-item",
												children: [
													(0, react_jsx_runtime.jsx)("span", { className: "greenroom-feishu-info-label", children: "应用 ID" }),
													(0, react_jsx_runtime.jsx)("span", { className: "greenroom-feishu-info-value", children: status?.appId || "未指定" })
												]
											}),
											(0, react_jsx_runtime.jsxs)("div", {
												className: "greenroom-feishu-info-item",
												children: [
													(0, react_jsx_runtime.jsx)("span", { className: "greenroom-feishu-info-label", children: "凭据状态" }),
													(0, react_jsx_runtime.jsx)("span", { className: "greenroom-feishu-info-value", style: { color: "#10b981" }, children: "有效且已绑定沙箱" })
												]
											}),
											status?.user?.scopes?.length > 0 && (0, react_jsx_runtime.jsxs)("div", {
												className: "greenroom-feishu-info-item",
												style: { flexDirection: "column", gap: "6px" },
												children: [
													(0, react_jsx_runtime.jsx)("span", { className: "greenroom-feishu-info-label", children: "已授权权限范围" }),
													(0, react_jsx_runtime.jsx)("div", {
														className: "greenroom-feishu-scopes",
														children: status.user.scopes.map((scope) => (0, react_jsx_runtime.jsx)("span", {
															className: "greenroom-feishu-scope-tag",
															children: scope
														}, scope))
													})
												]
											})
										]
									}),
									(0, react_jsx_runtime.jsxs)("div", {
										style: { display: "flex", gap: "10px", marginTop: "16px" },
										children: [
											(0, react_jsx_runtime.jsx)("button", {
												type: "button",
												className: "greenroom-feishu-btn-danger",
												onClick: handleLogout,
												disabled: actionLoading,
												children: "退出飞书登录"
											}),
											(0, react_jsx_runtime.jsx)("button", {
												type: "button",
												className: "greenroom-feishu-btn-secondary",
												onClick: fetchStatus,
												disabled: actionLoading,
												children: "刷新状态"
											})
										]
									})
								]
							}) : (0, react_jsx_runtime.jsxs)("div", {
								children: [
									(0, react_jsx_runtime.jsx)("p", {
										style: { fontSize: "13px", color: "rgba(255, 255, 255, 0.7)", margin: "0 0 16px 0" },
										children: "当前沙箱未绑定飞书账号。点击下方按钮发起设备码授权登录："
									}),
									!authData ? (0, react_jsx_runtime.jsx)("button", {
										type: "button",
										className: "greenroom-feishu-btn-primary",
										onClick: handleStartAuth,
										disabled: actionLoading,
										children: actionLoading ? "正在发起授权..." : "发起飞书登录"
									}) : (0, react_jsx_runtime.jsxs)("div", {
										className: "greenroom-feishu-auth-box",
										children: [
											(0, react_jsx_runtime.jsx)("div", {
												style: { fontSize: "13px", fontWeight: 600, color: "#10b981" },
												children: "步骤 1：复制验证码并在飞书中完成授权"
											}),
											authData.user_code && (0, react_jsx_runtime.jsxs)("div", {
												className: "greenroom-feishu-code-display",
												children: [
													(0, react_jsx_runtime.jsx)("span", {
														className: "greenroom-feishu-code",
														children: authData.user_code
													}),
													(0, react_jsx_runtime.jsx)("button", {
														type: "button",
														className: "greenroom-feishu-btn-secondary",
														onClick: () => handleCopy(authData.user_code),
														children: copied ? "已复制" : "复制验证码"
													})
												]
											}),
											authData.verification_url && (0, react_jsx_runtime.jsx)("div", {
												children: (0, react_jsx_runtime.jsx)("button", {
													type: "button",
													className: "greenroom-feishu-btn-primary",
													onClick: () => window.open(authData.verification_url, "_blank"),
													children: "前往飞书授权网页"
												})
											}),
											(0, react_jsx_runtime.jsx)("div", {
												style: { fontSize: "12px", color: "rgba(255, 255, 255, 0.6)", marginTop: "4px" },
												children: "系统正在自动轮询等待授权完成（有效期 10 分钟）。若已在飞书确认，也可点击下方立即检查："
											}),
											(0, react_jsx_runtime.jsxs)("div", {
												style: { display: "flex", gap: "10px", marginTop: "8px" },
												children: [
													(0, react_jsx_runtime.jsx)("button", {
														type: "button",
														className: "greenroom-feishu-btn-secondary",
														onClick: handleCheckPoll,
														disabled: actionLoading,
														children: actionLoading ? "正在检查..." : "已完成授权，立即检查"
													}),
													(0, react_jsx_runtime.jsx)("button", {
														type: "button",
														className: "greenroom-feishu-btn-secondary",
														onClick: () => setAuthData(null),
														children: "取消"
													})
												]
											})
										]
									})
								]
							}),

							actionMsg && (0, react_jsx_runtime.jsx)("div", {
								className: "greenroom-feishu-alert greenroom-feishu-alert-info",
								children: actionMsg
							}),
							errorMsg && (0, react_jsx_runtime.jsx)("div", {
								className: "greenroom-feishu-alert greenroom-feishu-alert-error",
								children: errorMsg
							})
						]
					})
				]
			});
		}

		${installGreenroom.toString()}
		${installTrajectoryClient.toString()}
    return function install(ctx) {
      installTrajectoryClient(ctx, react, react_jsx_runtime.jsx);
      installGreenroom(ctx, react, react_jsx_runtime.jsx, ${JSON.stringify(MANAGED_TOOLS.filter(name => /^(aigc_|mcp__greenroom__)/.test(name)))}, ${JSON.stringify({ groups: CREATIVE_CATALOG.groups, plugins })}, ${!native});

			ctx.slots.inject("settings.section", () => {
				return ctx.slots.register({
					name: "settings.section",
					id: "feishu-cli",
					order: 250,
					label: "飞书 CLI"
				}, FeishuCliSection);
			});
		}

  })();
  exports.apply = (ctx) => {
    const result = apply(ctx);
    installGreenroomSections(ctx);
    return result;
  };`;
  writeFileSync(brandFile, uiMarker + '\n' +
    replaceRequired(brandContent, 'exports.apply=apply;', extension, 'official UI integration'));
}

if (native) {
  const file = join(nm, '@deepseek-ai/dsh-client-ui-settings-models/lib/client.js');
  const content = readFileSync(file, 'utf8');
  if (!content.includes('greenroom-managed-model-settings')) {
    // The live managed catalogue supplies the native selectors. Credentials and
    // model profiles are edited once from the host application.
    const wrapper = `},function GreenroomModelSettings(props){
      const snapshot=props.useSnapshot?.(value=>value);
      const names=[...new Set((snapshot?.rows||[]).filter(row=>isGreenroomModelProvider(row.entry.provider)).map(row=>row.entry.displayName))];
      const origin=new URL(document.referrer||"https://greenroom.localhost:18443").origin;
      return (0,react_jsx_runtime.jsxs)("div",{id:"greenroom-managed-model-settings",children:[
        (0,react_jsx_runtime.jsx)("p",{children:"Greenroom 托管模型自动同步。"}),
        ...(names.length?[(0,react_jsx_runtime.jsx)("p",{children:names.join(" · ")})]:[]),
        (0,react_jsx_runtime.jsx)("a",{href:origin+"/?panel=api",target:"_blank",rel:"noopener",children:"打开 Greenroom API 管理"}),
        (0,react_jsx_runtime.jsx)(ModelsSection,props)
      ]})
    }));`;
    const withProviderCheck = replaceRequired(content, 'function ModelsSection(props)',
      'function isGreenroomModelProvider(id){return id==="greenroom-gateway"||id.startsWith("greenroom-external-")}function ModelsSection(props)',
      'managed model provider check');
    const hideManagedEdits = replaceRequired(withProviderCheck, 'rows:snapshot.rows.map(',
      'rows:snapshot.rows.filter(row=>!isGreenroomModelProvider(row.entry.provider)).map(', 'managed model edit location');
    writeFileSync(file, replaceRequired(hideManagedEdits, '},ModelsSection));', wrapper, 'managed model settings'));
  }
}

patchManagedRuntime(nm, __dirname, native);
patchSkillCards(nm);
patchSessionForkUI(nm);
if (!native) patchPlanningRuntime(nm);
console.log('[patch-dsh] All DSH patches applied successfully.');
