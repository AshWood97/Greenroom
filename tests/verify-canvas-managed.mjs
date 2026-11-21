import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const source = process.env.GREENROOM_CANVAS_SOURCE;
if (!source) throw new Error('Set GREENROOM_CANVAS_SOURCE to the prepared pinned T8 source');
const req = createRequire(path.join(source, 'backend/package.json'));
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
if (process.argv.includes('--child')) {
  const express = req('express');
  const config = req(path.join(source, 'backend/src/config.js'));
  for (const key of ['DATA_DIR', 'INPUT_DIR', 'OUTPUT_DIR', 'THUMBNAILS_DIR', 'ASSET_PREVIEWS_DIR', 'ASSET_BLOB_DIR', 'COLLAB_UPLOAD_TEMP_DIR']) fs.mkdirSync(config[key], { recursive: true });
  const routes = req(path.join(source, 'backend/src/routes/projectRuns.js'));
  const runtime = routes.getRuntime();
  const createNodeRun = runtime.database.createNodeRun.bind(runtime.database);
  let nodeSerial = 99;
  const sameTimestamp = Date.now();
  runtime.database.createNodeRun = (input) => {
    const clock = Date.now;
    Date.now = () => sameTimestamp;
    try { return createNodeRun({ ...input, id: `fixture-node-run-${process.pid}-${String(nodeSerial--).padStart(3, '0')}` }); }
    finally { Date.now = clock; }
  };
  const app = express();
  app.use(express.json({ limit: '48mb' }));
  app.use('/api/canvas', req(path.join(source, 'backend/src/routes/canvas.js')));
  app.use('/api/project-runs', routes);
  app.use('/api/proxy', req(path.join(source, 'backend/src/routes/proxy.js')));
  const managed = req(path.join(source, 'backend/src/greenroom-managed-runtime.js')).installGreenroomCanvas(app, { config, getRuntime: routes.getRuntime });
  app.get('/ready', (_request, response) => response.json({ ready: true }));
  app.listen(config.PORT, '127.0.0.1', () => { managed.resume(); process.stdout.write('READY\n'); });
} else {
  const core = req(path.join(source, 'backend/src/greenroomExecution.js'));
  assert.equal(core.isManagedNode({ id: 'external', type: 'llm', data: { model: 'fixture-llm', providerSource: 'openai', providerId: 'outside' } }), false);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'greenroom-canvas-fixture-'));
  const clip = path.join(dir, 'red-blue.mp4');
  const encoded = spawnSync('ffmpeg', ['-v','error','-f','lavfi','-i','color=red:size=64x64:rate=10:d=0.1',
    '-f','lavfi','-i','color=blue:size=64x64:rate=10:d=0.9','-filter_complex','[0:v][1:v]concat=n=2:v=1:a=0',
    '-c:v','libx264','-pix_fmt','yuv420p',clip]);
  assert.equal(encoded.status, 0, String(encoded.stderr));
  const frameAssets = new Map(); let clipReads = 0, frameUploadAttempts = 0, failFrameUpload = false;
  const counts = { llm: 0, image: 0, video: 0, runninghub: 0 };
  const submissions = [];
  const tasks = new Map();
  let releaseImage = false, didRead503 = false, didQueryInterrupt = false;
  let releaseParallel = false, activeParallel = 0, maxParallel = 0, finishedParallel = 0, uploads = 0;
  const parallelPrompts = [];
  const reply = (response, data, status = 200) => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(data)); };
  const broker = http.createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1:3081');
    let body = Buffer.alloc(0);
    for await (const chunk of request) body = Buffer.concat([body, chunk]);
    if (url.pathname === '/plugin/t8/canvas/api/greenroom/models') return reply(response, { success: true, data: {
      llm: [{ id: 'fixture-llm', capabilities: { input_modalities: ['text', 'image'] } }], image: [{ id: 'fixture-image' }], video: [{ id: 'fixture-video' }],
    } });
    if (url.pathname === '/plugin/t8/v1/chat/completions') {
      counts.llm += 1;
      const value = JSON.parse(body);
      if (value.messages[0].content === 'FramePair sink') {
        assert.equal(value.messages[1].content[0].text, 'compare frames');
        assert.equal(value.messages[1].content.length, 3);
        for (const item of value.messages[1].content.slice(1)) assert(frameAssets.has(item.image_url.url));
        return reply(response, { choices: [{ message: { content: 'two extracted frames received' } }] });
      }
      if (String(value.messages[0].content).startsWith('Parallel')) {
        const prompt = value.messages[1].content[0].text;
        parallelPrompts.push(prompt);
        if (value.messages[0].content === 'Parallel sink') {
          assert.equal(finishedParallel, 4, 'dependent node starts only after all inputs finish');
          for (let index = 1; index <= 4; index++) assert(prompt.includes('parallel-root-' + index));
        } else {
          activeParallel += 1;
          maxParallel = Math.max(maxParallel, activeParallel);
          while (!releaseParallel) await wait(20);
          activeParallel -= 1;
          finishedParallel += 1;
        }
        return reply(response, { choices: [{ message: { content: prompt + ' output' } }] });
      }
      assert.equal(value.messages[0].content, 'Use the configured directing rule');
      assert.equal(value.messages[1].content[0].text, 'A new scene prompt');
      return reply(response, { choices: [{ message: { content: 'A cinematic optimized prompt' } }], usage: { total_tokens: 12 } });
    }
    if (url.pathname === '/api/media/uploads' && request.headers['x-asset-type'] === 'image') {
      frameUploadAttempts++;
      if (failFrameUpload) return reply(response, {error:'fixture upload response failure'}, 503);
      const id = 'frame-' + (frameAssets.size + 1), fileUrl = '/api/media/' + id;
      frameAssets.set(fileUrl, body);
      return reply(response, {assetId:id,fileUrl,fileName:decodeURIComponent(request.headers['x-file-name']),fileSize:body.length,mimeType:'image/png',assetType:'image'});
    }
    if (url.pathname === '/api/media/clip') { clipReads++; response.writeHead(200,{'Content-Type':'video/mp4'}); return response.end(fs.readFileSync(clip)); }
    if (frameAssets.has(url.pathname)) { response.writeHead(200,{'Content-Type':'image/png'}); return response.end(frameAssets.get(url.pathname)); }
    if (url.pathname === '/api/media/uploads') return reply(response, { assetId: 'text-' + ++uploads, fileUrl: '/api/media/text-' + uploads,
      fileName: 'canvas-text.txt', fileSize: body.length, mimeType: 'text/plain', assetType: 'document' });
    if (url.pathname.startsWith('/api/media/')) {
      if (url.pathname === '/api/media/image' && releaseImage && !didRead503) { didRead503 = true; return reply(response, { error: 'temporary asset reader unavailable' }, 503); }
      const mediaType = url.pathname.includes('image') ? 'image/png' : url.pathname.includes('text') ? 'text/plain' : 'video/mp4';
      response.writeHead(200, { 'Content-Type': mediaType }); return response.end('fixture-media');
    }
    if (request.method === 'POST' && /\/(?:image|video)\/submit$|\/runninghub\/submit$/.test(url.pathname)) {
      const kind = url.pathname.includes('runninghub') ? 'runninghub' : url.pathname.includes('/image/') ? 'image' : 'video';
      counts[kind] += 1;
      const value = JSON.parse(body);
      submissions.push({ kind, value, key: request.headers['x-t8-provider-submission'] });
      const id = kind === 'runninghub' ? 'grh_' + 'a'.repeat(32) : 'gwtsk_' + kind;
      tasks.set(id, { kind, polls: 0 });
      return reply(response, { success: true, data: { taskId: id, status: 'pending' } });
    }
    const id = url.pathname.includes('/image/status/') ? url.pathname.split('/').at(-1) : url.searchParams.get('taskId');
    const task = tasks.get(id);
    if (task) {
      task.polls += 1;
      if (task.kind === 'image' && !releaseImage) return reply(response, { success: true, data: { status: 'RUNNING' } });
      if (task.kind === 'video' && !didQueryInterrupt) {
        didQueryInterrupt = true;
        return reply(response, { error: 'temporary task lookup unavailable' }, 404);
      }
      const media = task.kind === 'runninghub' ? 'enhanced' : task.kind;
      return reply(response, { success: true, data: { status: 'SUCCESS', code: 0, urls: task.kind === 'image' ? ['/api/media/image', '/api/media/image-selected'] : ['/api/media/' + media], videoUrl: task.kind === 'video' ? '/api/media/video' : undefined } });
    }
    return reply(response, { error: 'fixture route absent ' + url.pathname }, 404);
  });
  await new Promise((resolve, reject) => broker.listen(3081, '127.0.0.1', resolve).once('error', reject));
  const port = await new Promise((resolve) => { const server = http.createServer(); server.listen(0, '127.0.0.1', () => { const value = server.address().port; server.close(() => resolve(value)); }); });
  let child;
  let childOutput = '';
  const start = async () => {
    child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--child'], { env: { ...process.env,
      T8PC_DEV_DATA_ROOT: dir, T8_COLLAB_MANAGEMENT_TOKEN: 'canvas-fixture-management-token-0123456789abcdef', PORT: String(port), HOST: '127.0.0.1' }, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (chunk) => { childOutput += chunk; });
    child.stderr.on('data', (chunk) => { childOutput += chunk; });
    for (let index = 0; index < 150; index++) {
      if (child.exitCode !== null) throw new Error('Canvas fixture failed to start: ' + childOutput);
      try { const ready = await fetch(`http://127.0.0.1:${port}/ready`); if (ready.ok) return; } catch {}
      await wait(100);
    }
    throw new Error('Canvas fixture startup timed out: ' + childOutput);
  };
  const call = async (route, options = {}) => {
    const response = await fetch(`http://127.0.0.1:${port}${route}`, { ...options, headers: { 'Content-Type': 'application/json', ...options.headers },
      ...(options.body && typeof options.body !== 'string' ? { body: JSON.stringify(options.body) } : {}) });
    const value = await response.json();
    assert.equal(response.ok && value.success, true, JSON.stringify(value));
    return value.data;
  };
  try {
    await start();
    const canvas = await call('/api/canvas', { method: 'POST', body: { name: 'No UI full workflow fixture' } });
    const nodes = [
      { id: 'llm', type: 'llm', data: { model: 'fixture-llm', userPrompt: 'A new scene prompt', prompt: 'Stale assistant output', system: 'Use the configured directing rule' } },
      { id: 'image', type: 'image', data: { model: 'greenroom-image', apiModel: 'fixture-image', aspectRatio: '9:16', sizeLevel: '1024x1024' } },
      { id: 'video', type: 'video', data: { mainId: 'greenroom-video', model: 'fixture-video', prompt: 'Animate the scene', ratio: '9:16', duration: 10, resolution: '1080p' } },
      { id: 'prompt-output', type: 'output', data: { pickKind: 'text', pickIndex: 0 } },
      { id: 'image-output', type: 'output', data: { pickKind: 'image', pickIndex: 1, imageUrl: '/api/media/stale' } },
      { id: 'video-output', type: 'output', data: { pickKind: 'video', pickIndex: 0 } },
      { id: 'audio-input', type: 'upload', data: { audioUrl: '/api/media/a0', audioUrl_1: '/api/media/a1' } },
      { id: 'audio-output', type: 'output', data: { pickKind: 'audio', pickIndex: 1 } },
      { id: 'pair', type: 'frame-pair', data: { firstFrameUrl: '/api/media/first', lastFrameUrl: '/api/media/last' } },
      { id: 'rh', type: 'greenroom-selected', data: { rhToolsActiveAppId: 'greenroom-rh-upscale', paramValues: { 'rh-upscale::resolution': { value: '4k' }, 'rh-upscale::outputFps': { value: '2x' } } } },
    ].map((node, index) => ({ ...node, position: { x: index * 360, y: 100 } }));
    const inputGraph = { nodes: [...nodes].reverse(), edges: [
      ...[['llm','prompt-output'],['prompt-output','image'],['image','image-output'],['image-output','video'],
        ['video','video-output'],['video-output','rh'],['audio-input','audio-output'],['audio-output','video']]
        .map(([source,target],index)=>({id:String(index),source,target})),
      {id:'first',source:'pair',target:'image',sourceHandle:'first'},
      {id:'last',source:'pair',target:'image',sourceHandle:'last'},
    ] };
    const order=core.managedOrder(inputGraph,['rh']);
    for(const [source,target] of [['llm','prompt-output'],['prompt-output','image'],['pair','image'],['image','image-output'],['image-output','video'],['audio-output','video'],['video','video-output'],['video-output','rh']]) assert(order.indexOf(source)<order.indexOf(target));
    await call('/api/canvas/' + canvas.id, { method: 'PUT', body: { ...canvas, ...inputGraph, baseRevision: canvas.revision } });
    const run = await call('/api/greenroom/runs', { method: 'POST', body: { canvasId: canvas.id, nodeIds: ['rh'], submissionId: 'one-request' } });
    assert.equal(run.runId, run.id);
    let accepted;
    for (let index = 0; index < 150; index++) {
      accepted = await call('/api/greenroom/runs/' + run.id);
      if (accepted.nodes.find((node) => node.nodeId === 'image')?.attempts.some((attempt) => attempt.taskId)) break;
      await wait(100);
    }
    assert.equal(counts.image, 1, childOutput);
    assert.equal(accepted.nodes.find((node) => node.nodeId === 'image')?.attempts.at(-1)?.taskId, 'gwtsk_image');
    child.kill('SIGKILL');
    await new Promise((resolve) => child.once('exit', resolve));
    releaseImage = true;
    await start();
    let final;
    for (let index = 0; index < 200; index++) {
      final = await call('/api/greenroom/runs/' + run.id);
      if (final.status === 'succeeded' || final.status === 'failed') break;
      await wait(100);
    }
    assert.equal(final.status, 'succeeded', JSON.stringify(final) + childOutput);
    assert.deepEqual(counts, { llm: 1, image: 1, video: 1, runninghub: 1 });
    assert.equal(didRead503, true);
    assert.equal(didQueryInterrupt, true);
    const image = submissions.find((entry) => entry.kind === 'image').value;
    const video = submissions.find((entry) => entry.kind === 'video').value;
    const rh = submissions.find((entry) => entry.kind === 'runninghub').value;
    assert.equal(image.prompt, 'A cinematic optimized prompt');
    assert.deepEqual(image.images, ['/api/media/first', '/api/media/last']);
    assert.deepEqual(video.images, ['/api/media/image-selected']);
    assert.deepEqual(video.reference_audio_urls, ['/api/media/a1']);
    assert.equal(video.duration, 10); assert.equal(video.resolution, '1080p'); assert.equal(video.aspect_ratio, '9:16');
    assert.equal(rh.fileUrl, '/api/media/video'); assert.equal(rh.resolution, '4k'); assert.equal(rh.outputFps, '2x');
    const saved = await call('/api/canvas/' + canvas.id);
    assert.equal(saved.nodes.find((node) => node.id === 'image').data.imageUrl, '/api/media/image');
    assert.equal(saved.nodes.find((node) => node.id === 'video').data.videoUrl, '/api/media/video');
    assert.equal(saved.nodes.find((node) => node.id === 'rh').data.videoUrl, '/api/media/enhanced');
    assert.equal(saved.nodes.find((node) => node.id === 'rh').data.status, 'success');
    assert.equal(saved.nodes.find(node=>node.id==='image-output').data.imageUrl,'/api/media/image-selected');
    assert.equal(saved.nodes.find(node=>node.id==='audio-output').data.audioUrl,'/api/media/a1');
    assert.equal(saved.nodes.find(node=>node.id==='pair').data.greenroomExecutionMode,'existing-frames');
    assert.ok(final.nodes.every((node) => node.status === 'succeeded'));
    const parallel = await call('/api/canvas', { method: 'POST', body: { name: 'Parallel DAG fixture' } });
    const roots = Array.from({ length: 4 }, (_, index) => ({ id: 'root-' + (index + 1), type: 'llm',
      position: { x: 0, y: index * 160 }, data: { model: 'fixture-llm', system: 'Parallel root', userPrompt: 'parallel-root-' + (index + 1) } }));
    const sink = { id: 'sink', type: 'llm', position: { x: 400, y: 0 }, data: { model: 'fixture-llm', system: 'Parallel sink' } };
    await call('/api/canvas/' + parallel.id, { method: 'PUT', body: { ...parallel, nodes: [...roots, sink],
      edges: roots.map((node) => ({ id: node.id + '-sink', source: node.id, target: 'sink' })), baseRevision: parallel.revision } });
    const dag = await call('/api/greenroom/runs', { method: 'POST', body: { canvasId: parallel.id, nodeIds: ['sink'] } });
    for (let index = 0; index < 100 && parallelPrompts.length < 3; index++) await wait(20);
    assert.equal(parallelPrompts.length, 3, 'three independent nodes start before any completes');
    assert.equal(maxParallel, 3);
    releaseParallel = true;
    let dagState;
    for (let index = 0; index < 150; index++) {
      dagState = await call('/api/greenroom/runs/' + dag.id);
      if (['succeeded', 'failed'].includes(dagState.status)) break;
      await wait(50);
    }
    assert.equal(dagState.status, 'succeeded', JSON.stringify(dagState) + childOutput);
    assert.equal(parallelPrompts.length, 5);
    assert.equal(maxParallel, 3);
    const frameCanvas = await call('/api/canvas', { method:'POST', body:{name:'Real headless FramePair fixture'} });
    const frameNodes = [
      {id:'clip',type:'upload',data:{videoUrl:'/api/media/clip'}},
      {id:'clip-output',type:'output',data:{pickKind:'video',pickIndex:0}},
      {id:'extract-pair',type:'frame-pair',data:{}},
      {id:'frames-output',type:'output',data:{}},
      {id:'frame-consumer',type:'llm',data:{model:'fixture-llm',userPrompt:'compare frames',system:'FramePair sink'}},
    ].map((node,index)=>({...node,position:{x:index*360,y:0}}));
    const frameEdges=[['clip','clip-output'],['clip-output','extract-pair'],['extract-pair','frames-output'],['frames-output','frame-consumer']]
      .map(([source,target],index)=>({id:'frame-edge-'+index,source,target}));
    await call('/api/canvas/'+frameCanvas.id,{method:'PUT',body:{...frameCanvas,nodes:frameNodes,edges:frameEdges,baseRevision:frameCanvas.revision}});
    const frameRun=await call('/api/greenroom/runs',{method:'POST',body:{canvasId:frameCanvas.id,nodeIds:['frame-consumer'],submissionId:'frame-pair-original'}});
    let framesState;
    for(let index=0;index<200;index++){
      framesState=await call('/api/greenroom/runs/'+frameRun.id);
      if(!['queued','running','polling'].includes(framesState.status))break;
      await wait(100);
    }
    assert.equal(framesState.status,'succeeded',JSON.stringify(framesState)+childOutput);
    const frameSaved=await call('/api/canvas/'+frameCanvas.id);
    const extracted=frameSaved.nodes.find(node=>node.id==='extract-pair').data;
    assert.equal(extracted.greenroomExecutionMode,'extracted-frames');
    assert.equal(framesState.nodes.find(node=>node.nodeId==='extract-pair').localResult.firstFrameUrl,extracted.firstFrameUrl);
    const sharp=req('sharp');
    for(const [url,expectedChannel] of [[extracted.firstFrameUrl,0],[extracted.lastFrameUrl,2]]){
      const {data,info}=await sharp(frameAssets.get(url)).raw().toBuffer({resolveWithObject:true});
      assert.equal(info.width,64);assert.equal(info.height,64);
      assert(data[expectedChannel]>200);assert(data[expectedChannel===0?2:0]<30);
    }
    assert.equal(clipReads,1);assert.equal(frameAssets.size,2);
    child.kill('SIGKILL'); await new Promise(resolve=>child.once('exit',resolve)); await start();
    assert.equal((await call('/api/greenroom/runs/'+frameRun.id)).status,'succeeded');
    assert.equal((await call('/api/greenroom/runs',{method:'POST',body:{canvasId:frameCanvas.id,nodeIds:['frame-consumer'],submissionId:'frame-pair-original'}})).id,frameRun.id);
    assert.equal(clipReads,1);assert.equal(frameAssets.size,2,'same run readback never extracts/uploads again');
    failFrameUpload=true;
    const uncertain=await call('/api/greenroom/runs',{method:'POST',body:{canvasId:frameCanvas.id,nodeIds:['extract-pair'],submissionId:'frame-upload-uncertain'}});
    let uncertainState;
    for(let index=0;index<150;index++){
      uncertainState=await call('/api/greenroom/runs/'+uncertain.id);
      if(!['queued','running','polling'].includes(uncertainState.status))break;
      await wait(100);
    }
    assert.equal(uncertainState.status,'interrupted',JSON.stringify(uncertainState));
    assert.equal(frameUploadAttempts,3);assert.equal(frameAssets.size,2);
    child.kill('SIGKILL');await new Promise(resolve=>child.once('exit',resolve));await start();
    failFrameUpload=false;
    assert.equal((await call('/api/greenroom/runs/'+uncertain.id)).status,'interrupted');
    await wait(150);
    assert.equal(frameUploadAttempts,3,'uncertain upload is not repeated after restart');
    assert.equal(clipReads,2);
    console.log('PASS FramePair uncertain upload stays interrupted across restart, with no repeated extraction/upload');
    console.log('PASS real FFmpeg FramePair red/blue PNG extraction, owner Asset upload, downstream Output/LLM consumption and original-run readback');
    console.log('PASS Canvas no-UI LLM→Output→image→Output→video→Output→RH, existing FramePair and secondary audio relay, restart recovery, query/archive retry, persisted outputs and dependency-ready DAG with member limit 3');
  } finally {
    if (child && child.exitCode === null) { child.kill('SIGKILL'); await new Promise((resolve) => child.once('exit', resolve)); }
    await new Promise((resolve) => broker.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
