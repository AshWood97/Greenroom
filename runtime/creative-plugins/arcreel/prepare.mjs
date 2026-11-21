import { copyFileSync, cpSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
const root = resolve(process.argv[2]);
const patch = (file, before, after) => {
  const filename = join(root, file);
  const source = readFileSync(filename, 'utf8').replaceAll('\r\n', '\n');
  if (!source.includes(before)) throw new Error(`ArcReel 适配位置已变化：${file}`);
  writeFileSync(filename, source.replace(before, after));
};
copyFileSync(new URL('managed.py', import.meta.url), join(root, 'greenroom_managed.py'));
copyFileSync(new URL('../managed-bridge.py', import.meta.url), join(root, 'greenroom_bridge.py'));
copyFileSync(new URL('start.py', import.meta.url), join(root, 'greenroom_start.py'));
cpSync(new URL('.', import.meta.url), join(root, 'greenroom-integration'), { recursive: true });

patch('server/app.py', '    catalog_sync = start_catalog_sync(async_session_factory)', '    catalog_sync = None  # Model choices are supplied by Greenroom.');
patch('server/app.py', '        await stop_official_sync(catalog_sync)', '        if catalog_sync is not None:\n            await stop_official_sync(catalog_sync)');
patch('server/app.py', '    sandbox_enabled = check_sandbox_available()', '    sandbox_enabled = False  # Greenroom delegates creative agent work to DSH.');
patch('server/app.py', '    await init_db()', '    await init_db()\n    from greenroom_managed import seed\n    await seed()');
patch('server/app.py', '    install_bare_provider_models(pre_upgrade.model)', '    from greenroom_managed import managed_bare_provider_model\n    install_bare_provider_models(managed_bare_provider_model)');
patch('server/app.py', '        from lib.config.recommended_models import freeze_effective_defaults\n\n        async with async_session_factory() as session:\n            await freeze_effective_defaults(session)', '        pass  # Greenroom seed installs only administrator-authorized defaults.');
patch('server/services/project/project_archive.py', '    def _load() -> BareProviderModels:\n        async def _query() -> pre_upgrade_recommendations.RecommendationTable:\n            async with session_factory() as session:\n                return await pre_upgrade_recommendations.current_recommendations(session)\n\n        return bridge.run(_query()).model\n\n    return _load', '    from greenroom_managed import managed_bare_provider_model\n    return lambda: managed_bare_provider_model');
patch('server/app.py', '    if session_store_enabled():', '    if False and session_store_enabled():');
patch('server/app.py', '    await assistant.assistant_service.startup(in_docker=is_docker, sandbox_enabled=sandbox_enabled)\n    assistant.assistant_service.session_manager.start_patrol()', '    # Embedded Claude startup and patrol are disabled in the managed build.');
patch('server/app.py', '    assistant.assistant_service.session_manager.set_autonomous_turn_listener(\n        project_event_service.publish_assistant_session_resumed\n    )', '    # Project events remain available to the business UI and DSH.');
patch('server/app.py', '    assistant.assistant_service.session_manager.set_autonomous_turn_listener(None)', '    # No embedded agent listener was started.');
const appFile = join(root, 'server/app.py');
let appSource = readFileSync(appFile, 'utf8');
appSource = appSource.replace(/app\.include_router\(\n    assistant\.router,[\s\S]*?\n\)/g, '# Embedded assistant routes are not mounted in Greenroom.');
appSource += '\nfrom greenroom_managed import install as install_greenroom\ninstall_greenroom(app)\n';
writeFileSync(appFile, appSource);

patch('lib/backends/backend_assembly/assembler.py', '    if is_custom_provider(provider_id):', `    if media_type in ('image', 'video', 'audio'):
        from greenroom_managed import ManagedImage, ManagedVideo, ManagedAudio, model_ids, accepted_model
        kind = 'tts' if media_type == 'audio' else media_type
        available = model_ids(kind)
        chosen = model_id or (available[0] if available else None)
        if chosen not in available and not (chosen and accepted_model(kind, chosen)):
            raise ValueError('该生成模型未获得 Greenroom 管理员授权')
        return ManagedImage(chosen) if media_type == 'image' else ManagedVideo(chosen) if media_type == 'video' else ManagedAudio(chosen)
    if is_custom_provider(provider_id):`);
patch('lib/backends/backend_assembly/assembler.py', '    if is_custom_provider(provider_id):\n        from lib.custom_provider.loader import select_custom_model', `    if media_type in ('image', 'video', 'audio'):
        from greenroom_managed import model_ids, accepted_model
        kind = 'tts' if media_type == 'audio' else media_type
        available = model_ids(kind)
        chosen = model_id or (available[0] if available else None)
        if chosen not in available and not (chosen and accepted_model(kind, chosen)):
            raise ValueError('该生成模型未获得 Greenroom 管理员授权')
        return chosen
    if is_custom_provider(provider_id):
        from lib.custom_provider.loader import select_custom_model`);
const catalogFile = join(root, 'lib/catalog/query.py');
writeFileSync(catalogFile, readFileSync(catalogFile, 'utf8') + `
# Greenroom's member-authorized catalog is the only model source for this build.
def _provider_models(provider_id: str) -> dict[str, CatalogModel]:
    from greenroom_managed import catalog_models
    return catalog_models(CatalogModel) if provider_id == 'openai' else {}

def get_model(provider_id: str, model_id: str, *, media_type: str | None = None) -> CatalogModel | None:
    model = _provider_models(provider_id).get(model_id)
    if model is None and provider_id == 'openai' and media_type in (None, 'audio'):
        from greenroom_managed import accepted_audio_catalog
        model = accepted_audio_catalog(model_id, CatalogModel)
    return model if model is not None and (media_type is None or model.media_type == media_type) else None

def provider_media_types(provider_id: str) -> list[str]:
    from greenroom_managed import accepted_model
    available = {model.media_type for model in _provider_models(provider_id).values()}
    if provider_id == 'openai':
        available.update(media for kind, media in [('image', 'image'), ('video', 'video'), ('tts', 'audio')] if accepted_model(kind))
    return sorted(available)

def provider_models(provider_id: str) -> list[ProviderModelView]:
    return [ProviderModelView(key, key, model, None, False, 1.0, base_model=model) for key, model in _provider_models(provider_id).items()]

def require_listed(provider_id: str, model_id: str, media_type: str) -> CatalogModel:
    from greenroom_managed import accepted_model
    model = get_model(provider_id, model_id, media_type=media_type)
    if model is not None:
        return model
    kind = {'text': 'llm', 'audio': 'tts'}.get(media_type, media_type)
    if provider_id == 'openai' and accepted_model(kind, model_id):
        return CatalogModel(display_name=model_id, media_type=media_type, capabilities=[])
    raise ModelNotInCatalogError(provider_id=provider_id, model_id=model_id, media_type=media_type)

def require_callable(provider_id: str, model_id: str, media_type: str) -> CatalogModel:
    from greenroom_managed import model_ids
    kind = {'text': 'llm', 'audio': 'tts'}.get(media_type, media_type)
    model = get_model(provider_id, model_id, media_type=media_type)
    if provider_id != 'openai' or model_id not in model_ids(kind) or model is None:
        raise ModelNotInCatalogError(provider_id=provider_id, model_id=model_id, media_type=media_type)
    return model
`);
patch('server/text_generation.py',
  '    facts = require_video_request_facts(await storyboard_request_facts(project, config_resolver))\n    durations = planning_durations(facts)',
  `    from greenroom_managed import storyboard_can_plan_without_video
    from lib.generation.video_request_facts import ENDPOINT_FIXED_PLANNING_DURATIONS
    facts = await storyboard_request_facts(project, config_resolver)
    if (isinstance(facts, VideoRequestFactsFailure) and facts.code == "video_capability_unavailable"
            and storyboard_can_plan_without_video()):
        durations = list(ENDPOINT_FIXED_PLANNING_DURATIONS)
    else:
        durations = planning_durations(require_video_request_facts(facts))`);

const specsFile = join(root, 'lib/backends/backend_assembly/specs.py');
patch('lib/backends/backend_assembly/specs.py',
  '"openai", derive_base_url=None, provider_name=None, registry_backend=_TEXT_OPENAI_RESPONSES_REGISTRY_BACKEND',
  '"openai", derive_base_url=None, provider_name=None, registry_backend=_TEXT_OPENAI_COMPAT_REGISTRY_BACKEND');
writeFileSync(specsFile, readFileSync(specsFile, 'utf8') + `
def declared_builtin_video_capabilities(provider_id: str, model_id: str, *, endpoint: str | None = None):
    from greenroom_managed import video_capabilities
    return video_capabilities(model_id)

def effective_builtin_video_capabilities(channel: VideoCapabilities, provider_id: str, model_id: str):
    # The managed catalog describes the actual model behind this provider.
    return channel
`);
patch('lib/backends/image_backends/base.py', '    project_name: str | None = None', '    project_name: str | None = None\n    task_id: str | None = None');
patch('lib/generation/media_generator.py', '                            project_name=self.project_name,\n                        )', '                            project_name=self.project_name,\n                            task_id=task_id,\n                        )');
patch('lib/generation/restart_recovery.py', '            if media_type == "image":', '            from greenroom_managed import recover_managed_submission\n            if await recover_managed_submission(task):\n                continue\n            if media_type == "image":\n                from greenroom_managed import requeue_managed\n                if await requeue_managed(task):\n                    continue');
patch('lib/generation/generation_worker.py', '        except DispatchProviderChanged as exc:', '        except __import__("greenroom_managed").ManagedQueryPending as exc:\n            if claim.revoked:\n                await fail_task_of_deleted_project(self.queue, task)\n                return\n            await __import__("greenroom_managed").waiting(task, exc)\n            return\n        except DispatchProviderChanged as exc:');
patch('lib/generation/video_resume.py', '        except NotImplementedError as exc:', '        except __import__("greenroom_managed").ManagedQueryPending as exc:\n            if claim.revoked:\n                await fail_task_of_deleted_project(self._queue, task)\n                await asyncio.shield(self.settle_unresumable_call(task, failure=exc))\n                return\n            await __import__("greenroom_managed").waiting(task, exc)\n            return\n        except NotImplementedError as exc:');
patch('server/services/tasks/render_tasks.py', '    return final_cut_task_result(result)', `    from greenroom_managed import archive_final_cut_task
    archive = await archive_final_cut_task(task, result, projects)
    final_result = final_cut_task_result(result)
    final_result["greenroom_archive"] = archive
    return final_result`);
// System config reads provide creative model/default metadata only, never credential configuration.
patch('server/routers/system_config.py', '    return {"settings": settings, "options": options}', '    settings = {key: value for key, value in settings.items() if not key.startswith(("anthropic_", "claude_", "agent_", "market_"))}\n    return {"settings": settings, "options": options}');

patch('frontend/vite.config.ts', 'export default defineConfig({', 'export default defineConfig({\n    base: "/plugins/arcreel/",');
function prefix(directory) {
  for (const item of readdirSync(directory, { withFileTypes: true })) {
    const filename = join(directory, item.name);
    if (item.isDirectory()) prefix(filename);
    else if (/\.(?:ts|tsx)$/.test(item.name) && !/\.test\./.test(item.name)) {
      let source = readFileSync(filename, 'utf8');
      source = source.replace(/(["'`])\/api(?=[/"'`])/g, '$1/plugins/arcreel/api')
        .replace(/(["'`])\/app(?=[/"'`?])/g, '$1/plugins/arcreel/app')
        .replace(/(["'`])\/login(?=[/"'`?])/g, '$1/plugins/arcreel/login');
      writeFileSync(filename, source);
    }
  }
}
prefix(join(root, 'frontend/src'));
patch('frontend/src/router.tsx', '<Route path="/">', '<Route path="/plugins/arcreel/">');
patch('frontend/src/router.tsx', '<SystemConfigPage />', '<div className="p-8">模型与服务由 Greenroom 管理员统一配置；创作参数可在项目设置中调整。</div>');
patch('frontend/src/components/layout/GlobalHeader.tsx', '<IconLink href={`~${ROUTE_APP_SETTINGS}`} label={t("dashboard:global_settings")}>', '{false && <IconLink href={`~${ROUTE_APP_SETTINGS}`} label={t("dashboard:global_settings")}>');
patch('frontend/src/components/layout/GlobalHeader.tsx', '        </IconLink>\n        <AgentPanelToggle />', '        </IconLink>}\n        <AgentPanelToggle />');
// API/agent administration has no lobby entry; project creation settings stay available.
patch("frontend/src/components/pages/lobby/LobbyHeader.tsx", "          <IconLink href={settingsSectionPath(\"external-agent\")} label={t(\"dashboard:settings_external_agent\")}>\n            <Bot aria-hidden />\n          </IconLink>", "");
patch("frontend/src/components/pages/lobby/LobbyHeader.tsx", "          <IconLink\n            href={ROUTE_APP_SETTINGS}\n            label={t(\"common:settings\")}\n            onboardingAnchor={ONBOARDING_ANCHORS.lobbySettings}\n          >\n            <Settings aria-hidden />\n            {!configComplete && (\n              <span\n                role=\"img\"\n                aria-label={t(\"common:config_incomplete\")}\n                className=\"absolute top-1 right-1 size-2 rounded-full bg-warn\"\n              />\n            )}\n          </IconLink>", "");
patch("frontend/src/components/pages/lobby/LobbyHeader.tsx", "\nfunction IconLink({\n  href,\n  label,\n  onboardingAnchor,\n  children,\n}: {\n  href: string;\n  label: string;\n  onboardingAnchor?: string;\n  children: ReactNode;\n}) {\n  return (\n    <Tooltip>\n      <TooltipTrigger\n        render={\n          <Link\n            href={href}\n            aria-label={label}\n            data-onboarding={onboardingAnchor}\n            // eslint-disable-next-line shadcn/require-static-classes -- 链接借用 buttonVariants 的 ghost/icon 外观；Button 渲染为链接会被 Base UI 加上 role=\"button\"，故不能换成 render={<Button />}，TooltipTrigger 自身不带样式（见 eslint.config.js 的 UNSTYLED_PRIMITIVES）\n            className={cn(buttonVariants({ variant: \"ghost\", size: \"icon\" }), \"relative\")}\n          />\n        }\n      >\n        {children}\n      </TooltipTrigger>\n      <TooltipContent>{label}</TooltipContent>\n    </Tooltip>\n  );\n}\n", "\n");
patch("frontend/src/components/pages/lobby/LobbyHeader.tsx", ", type ReactNode", "");
patch("frontend/src/components/pages/lobby/LobbyHeader.tsx", "Bot, ", "");
patch("frontend/src/components/pages/lobby/LobbyHeader.tsx", ", Settings", "");
patch("frontend/src/components/pages/lobby/LobbyHeader.tsx", "import { cn } from \"cn\";\n", "");
patch("frontend/src/components/pages/lobby/LobbyHeader.tsx", "ROUTE_APP_ASSETS, ROUTE_APP_SETTINGS, settingsSectionPath", "ROUTE_APP_ASSETS");
patch("frontend/src/components/pages/lobby/LobbyHeader.tsx", "import { useConfigStatusStore } from \"@/stores/config-status-store\";\n", "");
patch("frontend/src/components/pages/lobby/LobbyHeader.tsx", "  const configComplete = useConfigStatusStore((s) => s.isComplete);\n", "");
patch("frontend/src/components/pages/lobby/LobbyHeader.tsx", "资产库、外部 Agent 接入、已删除项目、「新建项目」分体按钮与设置靠右", "资产库、已删除项目与「新建项目」分体按钮靠右");
patch('frontend/src/components/layout/AgentPanelToggle.tsx', '  if (demoMode) return null;', '  if (demoMode || true) return null;');
patch('frontend/src/components/layout/StudioLayout.tsx', '  const agentOpen = demoMode || storeOpen;', '  const agentOpen = false && (demoMode || storeOpen);');
patch('frontend/src/components/layout/StudioLayout.tsx', '{demoMode ? <DemoAssistantPanel /> : <AgentCopilot />}', '{false && (demoMode ? <DemoAssistantPanel /> : <AgentCopilot />)}');
for (const [file, busy, sheet, indent] of [
  ['frontend/src/components/canvas/lorebook/AssetBrowseCard.tsx', 'busy', 'asset.sheetPath', '                    '],
  ['frontend/src/components/canvas/lorebook/CharacterDerivativeRow.tsx', 'rowBusy', 'sheetPath', '                      '],
]) {
  patch(file, '  CloudDownload,\n  CloudUpload,\n', '');
  patch(file, `${indent}<DropdownMenuItem disabled={!${sheet}} onClick={() => setDialog("provider-upload")}>
${indent}  <CloudUpload aria-hidden />
${indent}  {t("assets:provider_asset_upload")}
${indent}</DropdownMenuItem>
${indent}<DropdownMenuItem disabled={${busy}} onClick={() => openGuarded("provider-assets")}>
${indent}  <CloudDownload aria-hidden />
${indent}  {t("assets:provider_asset_select_from_library")}
${indent}</DropdownMenuItem>\n`, '');
}
patch('frontend/src/api/transport.ts', '  return response.json() as Promise<T>;', `  const value = await response.json();
  return JSON.parse(JSON.stringify(value, (_key, item) => typeof item === 'string' && item.startsWith('/api/') ? '/plugins/arcreel' + item : item)) as T;`);
// Visible source offer and attribution supplement the upstream legal notices.
patch('frontend/src/main.tsx', 'initTheme();', `initTheme();
const legal = document.createElement('div');
legal.style.cssText = 'position:fixed;bottom:2px;left:12px;font-size:10px;z-index:10000;background:var(--background);padding:2px 6px';
legal.innerHTML = '<a href="https://github.com/ArcReel/ArcReel" target="_blank" rel="noopener">Powered by ArcReel</a> · Greenroom 托管适配 · <a href="/plugins/arcreel/_greenroom/source">修改后完整源码</a>';
document.body.appendChild(legal);`);

patch('lib/backends/text_backends/openai.py', '        kwargs: dict = {"model": self._model, "messages": messages}', '        from greenroom_managed import text_parameters\n        kwargs: dict = {**text_parameters(), "model": self._model, "messages": messages}');

patch('lib/backends/audio_backends/base.py', '    speed: float | None = None', '    speed: float | None = None\n    task_id: str | None = None');
patch('lib/generation/media_generator.py', '                    language_type=language_type,\n                    speed=speed,', '                    language_type=language_type,\n                    speed=speed,\n                    task_id=task_id,');
patch('lib/generation/restart_recovery.py', '            if media_type == "audio":', '            if media_type == "audio":\n                from greenroom_managed import requeue_managed\n                if await requeue_managed(task):\n                    continue');

// Accepted image jobs recover by original ID without rechecking current catalog or recompressing old inputs.
patch('lib/generation/media_generator.py', "        await gate_image_request(\n            self._image_backend, provider_id=cast(str, self._image_provider_id), reference_count=len(ref_images)\n        )", "        from greenroom_managed import ManagedImage\n        image_backend = self._image_backend\n        accepted_image_backend = image_backend.accepted_request_backend(task_id, backend_output_path) if isinstance(image_backend, ManagedImage) else None\n        managed_image_resume = accepted_image_backend is not None\n        if managed_image_resume:\n            image_backend = accepted_image_backend\n        else:\n            reference_count = len(ref_images)\n            if isinstance(image_backend, ManagedImage):\n                prepared_image_backend = image_backend.prepared_request_backend(task_id, backend_output_path)\n                if prepared_image_backend is not None:\n                    image_backend = prepared_image_backend\n                    reference_count = prepared_image_backend.prepared_reference_count\n            await gate_image_request(\n                image_backend, provider_id=cast(str, self._image_provider_id), reference_count=reference_count\n            )");
patch('lib/generation/media_generator.py', '                specs = [ReferenceSpec(source=Path(r.path), role=RefRole.ARRAY) for r in ref_images]', '                specs = [] if managed_image_resume else [ReferenceSpec(source=Path(r.path), role=RefRole.ARRAY) for r in ref_images]');
patch('lib/generation/media_generator.py', '                model=self._image_backend.model,', '                model=image_backend.model,');
patch('lib/generation/media_generator.py', '                image_backend = self._image_backend\n', '');

// Formal image tasks have a trusted native task ID before default-model assembly.
patch('server/services/tasks/formal_image_commit.py', '        ctx = context or await resolve_generation_context(', '        from greenroom_managed import accepted_image_context\n        ctx = context or accepted_image_context(task_id, project_name, user_id) or await resolve_generation_context(');

// These image executors resolve a lane before the formal entry. Keep their native task identity.
patch('server/services/tasks/generation_tasks.py', "    project, project_path, generation_input = await asyncio.to_thread(_load)\n    context = await resolve_generation_context(", "    project, project_path, generation_input = await asyncio.to_thread(_load)\n    from greenroom_managed import accepted_image_context\n    context = accepted_image_context(task_id, project_name, user_id) or await resolve_generation_context(");
patch('server/services/tasks/derivative_sheet_tasks.py', "    project, project_path, target = inputs.project, inputs.project_path, inputs.target\n    context = await resolve_generation_context(", "    project, project_path, target = inputs.project, inputs.project_path, inputs.target\n    from greenroom_managed import accepted_image_context\n    context = accepted_image_context(task_id, project_name, user_id) or await resolve_generation_context(");
patch('server/services/tasks/generation_tasks.py', "        ctx = await resolve_generation_context(\n            project_name,\n            payload,\n            project=project,\n            project_path=project_path,\n            user_id=user_id,\n            image=ImageLaneRequest(generation_type=\"i2i\" if assembled else \"t2i\"),", "        from greenroom_managed import accepted_image_context\n        ctx = accepted_image_context(task_id, project_name, user_id) or await resolve_generation_context(\n            project_name,\n            payload,\n            project=project,\n            project_path=project_path,\n            user_id=user_id,\n            image=ImageLaneRequest(generation_type=\"i2i\" if assembled else \"t2i\"),");
patch('server/services/tasks/generation_tasks.py', "    context = await resolve_generation_context(\n        project_name,\n        payload,\n        project=project,\n        project_path=project_path,\n        user_id=user_id,\n        image=ImageLaneRequest(generation_type=\"i2i\" if inputs.generation_input.references else \"t2i\"),", "    from greenroom_managed import accepted_image_context\n    context = accepted_image_context(task_id, project_name, user_id) or await resolve_generation_context(\n        project_name,\n        payload,\n        project=project,\n        project_path=project_path,\n        user_id=user_id,\n        image=ImageLaneRequest(generation_type=\"i2i\" if inputs.generation_input.references else \"t2i\"),");

// Keep native override restrictions, bounded by the trusted managed image catalog.
patch('lib/backends/image_capabilities.py', "    builtin_provider = None if is_custom_provider(provider_id) else provider_id\n    return image_reference_limit(\n        capabilities=effective_image_capabilities(\n            backend.capabilities, model_id=backend.model, builtin_provider=builtin_provider\n        ),\n        entry_limit=entry_reference_limit(backend.model, builtin_provider=builtin_provider),\n        override=image_reference_override(catalog.user_added_capability_overrides(builtin_provider, backend.model))\n        if builtin_provider is not None\n        else None,\n        channel_limit=channel_limit,\n    )", "    builtin_provider = None if is_custom_provider(provider_id) else provider_id\n    override = image_reference_override(catalog.user_added_capability_overrides(builtin_provider, backend.model)) if builtin_provider is not None else None\n    from greenroom_managed import ManagedImage\n    if isinstance(backend, ManagedImage) and channel_limit is not None and override is not None:\n        # Old native overrides may restrict, but cannot raise the trusted managed ceiling.\n        override = min(override, channel_limit)\n    return image_reference_limit(\n        capabilities=effective_image_capabilities(\n            backend.capabilities, model_id=backend.model, builtin_provider=builtin_provider\n        ),\n        entry_limit=entry_reference_limit(backend.model, builtin_provider=builtin_provider),\n        override=override,\n        channel_limit=channel_limit,\n    )");
patch('lib/backends/image_capabilities.py', '    accepts = channel_accepts_explicit_quality(builtin_model_spec(provider_id, "image", model_id).registry_backend)', '    if provider_id == "openai":\n        from greenroom_managed import managed_image_quality_options\n        return managed_image_quality_options(model_id)\n    accepts = channel_accepts_explicit_quality(builtin_model_spec(provider_id, "image", model_id).registry_backend)');
