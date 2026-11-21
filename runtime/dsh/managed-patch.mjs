import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// Pinned-upstream edits fail the build if their execution boundary changes.
export function patchManagedRuntime(nm, runtimeDir, native = false) {
  const moduleURL = pathToFileURL(join(runtimeDir, 'greenroom-managed.mjs')).href;
  const marker = '// greenroom-managed-runtime-v1';
  function patch(pkg, file, replacements, imports = '') {
    const filename = join(nm, '@deepseek-ai', pkg, 'lib', file);
    let source = readFileSync(filename, 'utf8');
    if (source.includes(marker)) return;
    for (const [before, after] of replacements) {
      if (!source.includes(before)) throw new Error(`Managed runtime patch target changed: ${pkg}/${file}: ${before.slice(0, 80)}`);
      source = source.replace(before, after);
    }
    writeFileSync(filename, marker + '\n' + imports + source);
  }
  patch('dsh-client-ui-conversation', 'client.js', [
    ['"conversation.input.permission":{kind:`single`,scope:`session`}', '"greenroom.plugins.launcher":{kind:`single`,scope:`session-maybe`},"conversation.input.permission":{kind:`single`,scope:`session`}'],
    ['(0,react_jsx_runtime.jsxs)(`div`,{className:InputBar_module_css_default.dock,', 'renderSlot(`greenroom.plugins.launcher`,{variant}),(0,react_jsx_runtime.jsxs)(`div`,{className:InputBar_module_css_default.dock,'],
    ...(!native ? [
      ['"conversation.input.permission":{kind:`single`,scope:`session`}', '"conversation.input.permission":{kind:`single`,scope:`session-maybe`}'],
      ['sessionId===void 0?null:renderSlot(`conversation.input.permission`,{locked})', 'renderSlot(`conversation.input.permission`,{locked})'],
    ] : []),
  ]);
  patch('dsh-api-session-controller', 'index.js', [
    ['if (model.inputModalities !== void 0 && !model.inputModalities.includes("image")) throw new RemoteError("session/attachment-invalid", `Model "${current.model}" does not support image input.`, { reason: "MODEL_DOES_NOT_SUPPORT_IMAGES" });', 'if (model.inputModalities !== void 0 && !model.inputModalities.includes("image")) throw new RemoteError("session/attachment-invalid", isManagedModelImageCapabilityUnknown(current.model) ? "当前模型的图片能力尚未确认，请选择已确认支持图片的模型" : "当前模型不支持图片，请切换支持图片的模型", { reason: isManagedModelImageCapabilityUnknown(current.model) ? "MODEL_IMAGE_CAPABILITY_UNKNOWN" : "MODEL_DOES_NOT_SUPPORT_IMAGES" });'],
    ...(!native ? [
      ['async create(request) {', 'async create(request) {\n\t\trequest = { ...request, agentPreset: "greenroom-aigc" };'],
      ['const cwd = workspace?.path ?? request.cwd ?? this.defaultCwd;', 'const cwd = MANAGED_WORKSPACE;'],
      ['this.assertPresetApplicable(sessionId, request.agentPreset);', '/* Historical preset choices use the managed projection. */'],
      ['this.assertPresetApplicable(live.id, request.agentPreset);', '/* Live historical presets use the managed projection. */'],
      ['if (live.session.header.cwd !== request.cwd) throw new ApiSessionCwdConflict(live.id, request.cwd, live.session.header.cwd);', '/* Historical cwd does not change the managed execution workspace. */'],
      ['if (observed.header.cwd !== request.cwd) throw new ApiSessionCwdConflict(sessionId, request.cwd, observed.header.cwd);', '/* Persisted cwd does not change the managed execution workspace. */'],
    ] : []),
  ], `import { MANAGED_WORKSPACE, isManagedModelImageCapabilityUnknown } from ${JSON.stringify(moduleURL)};\n`);
  if (native) return;
  const bootPackage = join(nm, '@deepseek-ai/dsh/lib');
  const bootFile = readdirSync(bootPackage).find((file) => /^profile-boot-[\w-]+\.js$/.test(file));
  if (!bootFile) throw new Error('Managed runtime profile boot target is missing');
  patch('dsh', bootFile, [
    [
      'const profile = resolvedProfile?.profile ?? prepareProfile(name, true, fromDefaultProfile);\n\tif (resolvedProfile !== void 0) writeFileSync(join(profile.dir, PROFILE_ROOT_FILENAME), PROFILE_ROOT_CONFIG);\n\treturn {\n\t\tprofile,\n\t\tresolution: await createRuntimeResolution({\n\t\t\tinstallAnchor: resolvedProfile?.installAnchor ?? INSTALL_ANCHOR,\n\t\t\tprofile\n\t\t}),\n\t\toverlays: patchFiles.flatMap((file) => loadOverlayPatches(NAME, resolve(file)))\n\t};',
      'return composeManagedProfile(INSTALL_ANCHOR, name, patchFiles, fromDefaultProfile, resolvedProfile);',
    ],
    ['app.current = ctx;\n\t\tif (!signalShutdown.signal.aborted', 'app.current = ctx;\n\t\tawait assertManagedRuntime(ctx);\n\t\tif (!signalShutdown.signal.aborted'],
  ], `import { composeManagedProfile, assertManagedRuntime } from ${JSON.stringify(moduleURL)};\n`);
  patch('dsh-attachment-local', 'index.js', [
    ['const temporary = `${path}.${randomUUID()}.tmp`;\n\ttry {\n\t\tawait writeFile(temporary, data, {', 'const temporary = `${path}.${randomUUID()}.tmp`;\n\tconst releaseCache = reserveAttachmentCache(path, data.byteLength);\n\ttry {\n\t\tawait writeFile(temporary, data, {'],
    ['await rename(temporary, path);\n\t} finally {\n\t\tawait rm(temporary, { force: true });\n\t}\n}', 'await rename(temporary, path);\n\t} finally {\n\t\ttry { await rm(temporary, { force: true }); } finally { releaseCache(); }\n\t}\n}'],
  ], `import { reserveAttachmentCache } from ${JSON.stringify(pathToFileURL(join(runtimeDir, 'attachment-tools.mjs')).href)};\n`);
  patch('dsh-app-boot', 'index.js', [
    ['...loadOptionalPatches(binName, join(context.home, "cordis.patch.yml")) ?? [],', '/* Personal home patches are never read in the managed runtime. */'],
    ['const project = readEnvLayer(binName, cwd, warn, home);', 'const project = undefined;'],
    ['const user = home === resolve(cwd) ? void 0 : readEnvLayer(binName, home, warn, home);', 'const user = undefined;'],
  ]);
  patch('dsh-sandbox-policy', 'index.js', [
    ['mode: request.mode ?? (session === void 0 ? void 0 : this.overrideOf(session)) ?? this.defaultMode,', 'mode: "read-only",'],
    ['workspaceRoot: this.sessionWorkspaceRoot(session),', 'workspaceRoot: MANAGED_WORKSPACE,'],
    ['return this.sandboxModeProjectionHandle.stateOf(session) ?? void 0;', 'return "read-only";'],
    ['init: () => null,\n\t\t\tapply: (state, event) => event.type === "sandbox/mode" ? event.data.mode : state', 'init: () => "read-only",\n\t\t\tapply: () => "read-only"'],
  ], `import { MANAGED_WORKSPACE } from ${JSON.stringify(moduleURL)};\n`);
  patch('dsh-agent-preset-registry', 'index.js', [
    ['init: (header) => header.agentPreset ?? null,', 'init: () => "greenroom-aigc",'],
    ['apply: (state, event) => event.type === "agent-preset/selected" ? event.data.agentPreset : state,', 'apply: () => "greenroom-aigc",'],
    ['const wanted = id ?? this.defaultId;', 'const wanted = "greenroom-aigc";'],
    ['async retain(id) {\n\t\t\tconst wanted = id ?? this.defaultId;', 'async retain(id) {\n\t\t\tconst wanted = "greenroom-aigc";'],
    ['async select(agent, agentPreset) {', 'async select(agent, agentPreset) {\n\t\t\tif (agentPreset !== "greenroom-aigc") throw new RemoteError("greenroom/managed-mode", "Greenroom uses managed creation mode", {});'],
    ['get defaultId() {', 'get defaultId() {\n\t\t\treturn "greenroom-aigc";'],
  ]);
  patch('dsh-session', 'index.js', [
    ['prepare(id, options) {', 'prepare(id, options) {\n\t\toptions = { ...options, meta: { ...options?.meta, cwd: MANAGED_WORKSPACE, agentPreset: "greenroom-aigc" } };'],
  ], `import { MANAGED_WORKSPACE } from ${JSON.stringify(moduleURL)};\n`);
  patch('dsh-api-workspace-controller', 'index.js', [
    ['create(request) {', `create(request) {
			const rawTitle = typeof request?.title === 'string' ? request.title.trim() : '';
			let targetPath = request?.path;
			const groupPrefix = MANAGED_WORKSPACE + '/.groups/';
			const groupName = typeof targetPath === 'string' && targetPath.startsWith(groupPrefix) ? targetPath.slice(groupPrefix.length) : '';
			// New groups must be a single directory name before any filesystem write.
			if (!groupName || groupName === '.' || groupName === '..'
				|| groupName.includes('/') || groupName.includes(String.fromCharCode(92)) || groupName.includes(String.fromCharCode(0))) {
				const groupId = 'group_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
				targetPath = MANAGED_WORKSPACE + '/.groups/' + groupId;
			}
			try {
				mkdirSync(targetPath, { recursive: true });
			} catch (_) {}
			const finalTitle = rawTitle || '新建分组';
			request = { ...request, path: targetPath, title: finalTitle };`],
    ['workspace: workspaceView(await this.ctx.workspaceRegistry.create(request.path)),',
     'workspace: workspaceView(await this.ctx.workspaceRegistry.create(request.path, request.title)),'],
  ], `import { mkdirSync } from 'node:fs';\nimport { MANAGED_WORKSPACE } from ${JSON.stringify(moduleURL)};\n`);
  patch('dsh-api-gateway', 'index.js', [
    ['const endpoint = endpointOf(request.namespace, request.method);\n\t\tassertPeerLive(request.peer, endpoint);\n\t\tconst descriptor =', `const endpoint = endpointOf(request.namespace, request.method);
\t\tassertPeerLive(request.peer, endpoint);
\t\tif (new Set(["terminal", "workingDirectory", "workspaceFiles", "fileReferences", "permissionPresets", "directoryPicker", "dynamicCordisRunner", "cordisInspect", "pluginManager", "configEditor", "loader", "credentials", "account"]).has(request.namespace)
\t\t\t|| request.namespace === "skills" && request.method !== "list"
\t\t\t|| request.namespace === "settings" && request.method !== "describe"
\t\t\t|| request.namespace === "session" && ["openWorkspacePath", "workspacePathApplications"].includes(request.method)) {
\t\t\tthrow new RemoteError("greenroom/managed-mode", "Greenroom 创作模式不允许修改程序或访问通用终端、文件与配置接口", {});
\t\t}
\t\tconst descriptor =`],
  ]);
  patch('dsh-api-settings-controller', 'index.js', [
    ['const settings = this.provider();\n\t\t\treturn {\n\t\t\t\twritable: settings.writable,\n\t\t\t\thasDocument: true,\n\t\t\t\tnamespaces: settings.describe({ redactSecrets: true }).map(namespaceView)\n\t\t\t};', 'return { writable: false, hasDocument: false, namespaces: [] };'],
    ['ctx.plugin(CredentialsController);', '/* Personal credential configuration is not exposed. */'],
  ]);
  patch('dsh-client-ui-settings-general', 'client.js', [
    ['ctx.slots.inject(`settings.general.item`,()=>ctx.slots.register({name:`settings.general.item`,id:`developer-tools`,order:15,locale:NS,inject:()=>({hooks:{developerTools:ctx.configForms.developerTools.enabled},setEnabled:async enabled=>{const settings=ctx.configForms.get(`ui-settings`);const previous=settings.getSnapshot().value?.enabled;const timestamp=Date.now();await ctx.configForms.developerTools.setEnabled(enabled);if(previous!==void 0&&previous!==enabled&&settings.getSnapshot().value?.enabled===enabled)ctx.get(`productAnalytics`)?.track(`code_work_view_toggle`,{is_enabled:enabled},timestamp)}})},DeveloperToolsRow));', '/* Coding views are not part of the managed creation workspace. */'],
  ]);
  patch('dsh-client-ui-settings', 'client.js', [
    ['this.enabled={getSnapshot:()=>scope.getSnapshot().value?.enabled??false,subscribe:listener=>{let previous=this.enabled.getSnapshot();return scope.subscribe(()=>{const next=this.enabled.getSnapshot();if(next===previous)return;previous=next;listener()})}}', 'this.enabled={getSnapshot:()=>false,subscribe:()=>()=>{}}'],
    ['async setEnabled(enabled){if(!await this.scope.set(`enabled`,enabled))throw new Error(`Developer tools preference was not saved`)}', 'async setEnabled(_enabled){}'],
    ['const DeveloperToolsSettingsFields={enabled:Schema.boolean().default(true)};', 'const DeveloperToolsSettingsFields={enabled:Schema.boolean().default(false)};'],
  ]);
  patch('dsh-client-ui-chat', 'client.js', [
    ['function isAtOrOutside(node,position){', `function isAtOrOutside(node,position){
\t\t\tif (node?.kind === "tool-call" && /^(aigc_|mcp__greenroom__)/.test(node.data.root.call?.name ?? node.data.root.name ?? "")) return position === "process" || position === "turn";`],
  ]);
}
