import { readFileSync, writeFileSync, cpSync, mkdirSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
const root = resolve(process.argv[2]);
const patch = (file, before, after) => {
  const path = join(root, file), source = readFileSync(path, 'utf8');
  if (!source.includes(before)) throw new Error(`ViMax integration target changed: ${file}`);
  writeFileSync(path, source.replaceAll(before, after));
};
patch('web/vite.config.ts', 'plugins: [react()],', "plugins: [react()],\n  base: '/plugins/vimax/',");
patch('web/src/api.ts', 'fetch(url,', "fetch('/plugins/vimax' + url,");
patch('web/src/api.ts', "new EventSource('/api/events')", "new EventSource('/plugins/vimax/api/events')");
patch('web/src/App.tsx', "<button className={activeView === 'settings' ? 'is-active' : ''} onClick={onSettings}><Settings size={17} /><span>Settings</span></button>", '');
// Completion events also update planning artifacts; late reads must stay in their selected project/request scope.
patch('web/src/App.tsx', "const [selectedSessionId, setSelectedSessionId] = useState('');", "const [selectedSessionId, updateSelectedSessionId] = useState('');");
patch('web/src/App.tsx', '  const [artifacts, setArtifacts] = useState<Artifact[]>([]);', `  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const selectedSessionIdRef = useRef('');
  const artifactsRequestRef = useRef(0);
  const setSelectedSessionId = useCallback((sessionId: string) => {
    if (selectedSessionIdRef.current !== sessionId) {
      selectedSessionIdRef.current = sessionId;
      artifactsRequestRef.current += 1;
      setArtifacts([]);
    }
    updateSelectedSessionId(sessionId);
  }, []);`);
patch('web/src/App.tsx', `  const refreshArtifacts = useCallback(async (sessionId: string) => {
    if (!sessionId) {
      setArtifacts([]);
      return;
    }
    const payload = await getArtifacts(sessionId);
    setArtifacts(payload.artifacts);
  }, []);`, `  const refreshArtifacts = useCallback(async (sessionId: string) => {
    if (selectedSessionIdRef.current !== sessionId) return;
    const request = ++artifactsRequestRef.current;
    if (!sessionId) {
      setArtifacts([]);
      return;
    }
    try {
      const payload = await getArtifacts(sessionId);
      if (selectedSessionIdRef.current === sessionId && artifactsRequestRef.current === request) setArtifacts(payload.artifacts);
    } catch (error) {
      if (selectedSessionIdRef.current === sessionId && artifactsRequestRef.current === request) throw error;
    }
  }, []);`);
patch('web/src/App.tsx', `      if (event.activeSessionId) setSelectedSessionId(event.activeSessionId);
      return;`, `      if (event.activeSessionId) setSelectedSessionId(event.activeSessionId);
      const sessionId = selectedSessionIdRef.current;
      void refreshArtifacts(sessionId).catch((error) => {
        if (selectedSessionIdRef.current === sessionId) setLoadError(error instanceof Error ? error.message : String(error));
      });
      return;`);
patch('web/src/App.tsx', '[refreshArtifacts, refreshSessions]);', '[refreshArtifacts, refreshSessions, setSelectedSessionId]);');
// Explicit member project and typed upload references; no hidden agent-loop file reads.
patch('web/src/api.ts', 'export async function sendMessage(text: string)', 'export async function sendMessage(text: string, sessionId: string, uploads: string[])');
patch('web/src/api.ts', 'const payload = await response.json();', `const payload = response.headers.get('content-type')?.includes('application/json') ? await response.json() : {error: await response.text()};`);
patch('web/src/api.ts', 'JSON.stringify({text})', 'JSON.stringify({text, sessionId, uploads})');
patch('web/src/api.ts', "return request<{ok: boolean}>('/api/agent/start'", "return request<{ok: boolean; sessionId: string}>('/api/agent/start'");
patch('web/src/App.tsx', 'applyAgentEvent, appendLocalUser, composeAgentPrompt, createChatState', 'applyAgentEvent, appendLocalUser, createChatState');
patch('web/src/App.tsx', `      if (!agentReady) {
        await startAgent(selectedSessionId ? {sessionId: selectedSessionId} : {newSession: true});`, `      let messageSessionId = selectedSessionId;
      if (!agentReady || !messageSessionId) {
        const started = await startAgent(selectedSessionId ? {sessionId: selectedSessionId} : {newSession: true});
        messageSessionId = started.sessionId;`);
patch('web/src/App.tsx', `      const outbound = composeAgentPrompt(text, workspaceUploads.map((file) => file.path));
      await sendMessage(outbound);`, `      await sendMessage(text, messageSessionId, workspaceUploads.map((file) => file.path));`);
patch('web/src/slashCommands.ts', "  {name: '/compact', description: 'Compact the current session context'},", `  {name: '/novel', description: '规划小说正文，或读取已上传的一个 UTF-8 TXT；需要托管文本、embedding 和 rerank'},
  {name: '/script', description: '规划剧本正文，或读取已上传的一个 UTF-8 TXT'},
  {name: '/render', description: '从当前工程已有规划生成媒体；小说输出逐场景影片'},`);
patch('agent_runtime/vimax_adapters.py', '"ready_for_scene_render": False', '"ready_for_scene_render": ready');
patch('pipelines/script2video_pipeline.py', 'prompt=prompt, reference_image_paths=reference_image_paths, size=size,', 'prompt=prompt, reference_image_paths=reference_image_paths, size=size, greenroom_key=str(candidates_save_dir or ""),');
patch('pipelines/script2video_pipeline.py', 'greenroom_key=str(candidates_save_dir or ""),\n                    )', 'greenroom_key=str(path),\n                    )');
patch('pipelines/script2video_pipeline.py', 'progress=_scoped_progress(progress, shot_idx=shot_description.idx, artifact="video_clip"),', 'progress=_scoped_progress(progress, shot_idx=shot_description.idx, artifact="video_clip"), greenroom_key=video_path,');
for (const directory of ['agents', 'pipelines', 'agent_runtime']) {
  for (const file of readdirSync(join(root, directory)).filter(file => file.endsWith('.py'))) {
    const path = join(root, directory, file), source = readFileSync(path, 'utf8');
    writeFileSync(path, source.replaceAll('from langchain.chat_models import init_chat_model', 'from greenroom.managed_generators import managed_chat_model as init_chat_model')
      .replaceAll('from langchain_openai import OpenAIEmbeddings', 'from greenroom.managed_generators import managed_embeddings as OpenAIEmbeddings'));
  }
}
patch('tools/reranker_bge_silicon_api.py', "        headers = {", "        from greenroom.managed_generators import managed_defaults\n        payload = {**managed_defaults('rerank'), **payload}\n        headers = {");
patch('tools/reranker_bge_silicon_api.py', '            "return_documents": True,\n', '');
patch('tools/reranker_bge_silicon_api.py', 'result["document"]["text"]', 'documents[result["index"]]');
// Rerank shares the original task's unknown/success ledger with chat and embeddings.
// httpx errors are deliberately outside the upstream aiohttp retry decorator.
patch('tools/reranker_bge_silicon_api.py', `        async with aiohttp.ClientSession() as session:
            async with session.post(url, json=payload, headers=headers) as resp:
                response = await resp.json()
                if resp.status >= 400:
                    raise RuntimeError(f"Rerank request failed with HTTP {resp.status}: {response}")`, `        from greenroom.managed_generators import ManagedAsyncTextClient
        async with ManagedAsyncTextClient(timeout=300.0) as client:
            resp = await client.post(url, json=payload, headers=headers)
            response = resp.json()`);
mkdirSync(join(root, 'greenroom'), { recursive: true });
for (const file of ['server.py', 'managed_generators.py', 'final_media.py', 'derived_media.py']) cpSync(new URL(file, import.meta.url), join(root, 'greenroom', file));

// Admission at the pinned native media writer boundaries. This is a free-space
// preflight, not a hard quota for an unknown-size long-running encoder.
for (const [file, writes] of [
  ['pipelines/script2video_pipeline.py', [
    'final_video.write_videofile(final_video_path, codec="libx264", preset="medium")',
    'transition_video_output.save(transition_video_path)', 'new_camera_image.save(new_camera_image_path)',
    'ff_image.save(first_shot_ff_path)', 'video_output.save(video_path)', 'frame_image.save(frame_image_path)',
    'front_portrait_output.save(front_portrait_path)', 'side_portrait_output.save(side_portrait_path)',
    'back_portrait_output.save(back_portrait_path)', 'await asyncio.to_thread(output.save, str(path))',
  ]],
  ['pipelines/idea2video_pipeline.py', [
    'front_portrait_output.save(front_portrait_path)', 'side_portrait_output.save(side_portrait_path)',
    'back_portrait_output.save(back_portrait_path)', 'concatenate_video_files(all_video_paths, final_video_path)',
  ]],
  ['pipelines/novel2movie_pipeline.py', ['image.save(image_path)']],
]) {
  for (const line of writes) {
    const filename = join(root, file), text = readFileSync(filename, 'utf8');
    const escaped = line.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const expression = new RegExp('^( +)' + escaped + '$', 'gm');
    if (!expression.test(text)) throw new Error('ViMax native media writer changed: ' + file + ': ' + line);
    writeFileSync(filename, text.replace(expression, '$1from greenroom.final_media import guard_write\n$1guard_write()\n$1' + line));
  }
}
