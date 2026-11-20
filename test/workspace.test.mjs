import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { bridgeKey } from '../lib/credentials.mjs';

const fixtureKey = 'fixture-local-key';
const pngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACklEQVR4nGNgAAIAAAUAAV6nX1QAAAAASUVORK5CYII=';
const modelIds = ['gpt-6-luna','gpt-image-2.6-flare','tts-1','sora','text-embedding-3-small'];
async function listen(handler) {
  const server = createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return server;
}
async function freePort() {
  const server = await listen((_, res) => res.end());
  const { port } = server.address();
  await new Promise(resolve => server.close(resolve));
  return port;
}
function fixtureResponse(res, status, body) {
  res.writeHead(status, { 'Content-Type':'application/json' });
  res.end(JSON.stringify(body));
}
function ready(child) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Greenroom startup timed out')), 5000);
    child.stdout.once('data', () => { clearTimeout(timer); resolve(); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error('Greenroom exited ' + code)); });
  });
}
async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode) return;
  const exit = once(child,'exit');
  child.kill('SIGTERM');
  await exit;
}

test('independent workspace, original supplier recovery, local MCP and official DSH', { timeout:90_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(),'greenroom-acceptance-'));
  const upstreamCalls = [];
  let failQuery = true;
  const upstream = await listen(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : null;
    upstreamCalls.push({ method:req.method, path:req.url, body, key:req.headers.authorization });
    if (req.url.endsWith('/models')) return fixtureResponse(res, 200, { data:modelIds.map(id => ({ id })) });
    if (req.url === '/v1/responses/resp_original') {
      if (failQuery) return fixtureResponse(res, 503, { error:{ message:'temporarily unavailable' } });
      return fixtureResponse(res, 200, { id:'resp_original', status:'completed',
        output:[{ content:[{ type:'output_text', text:'原任务完成。' }] }] });
    }
    if (req.url.endsWith('/responses')) {
      if (body.input === '拒绝样本') return fixtureResponse(res, 400, { error:{ message:'invalid ' + req.headers.authorization } });
      if (body.background) return fixtureResponse(res, 200, { id:'resp_original', status:'queued' });
      return fixtureResponse(res, 200, { status:'completed',
        output:[{ content:[{ type:'output_text', text:'雨后的车站。' }] }] });
    }
    if (req.url.endsWith('/chat/completions')) {
      if (body.stream) {
        const fields = { id:'chatcmpl_greenroom_fixture', model:'gpt-6-luna', object:'chat.completion.chunk', created:1 };
        const events = [
          { ...fields, choices:[{ index:0, delta:{ role:'assistant', content:'官方 DSH 回复通过。' }, finish_reason:null }] },
          { ...fields, choices:[{ index:0, delta:{}, finish_reason:'stop' }],
            usage:{ prompt_tokens:5, completion_tokens:4, total_tokens:9 } },
        ];
        res.writeHead(200, { 'Content-Type':'text/event-stream' });
        res.end(events.map(event => 'data: ' + JSON.stringify(event) + '\n\n').join('') + 'data: [DONE]\n\n');
        return;
      }
      return fixtureResponse(res, 200, { choices:[{ message:{ content:'兼容文字。' } }] });
    }
    if (req.url.endsWith('/images/generations')) {
      return fixtureResponse(res, 200, { data:[{ b64_json:pngBase64 }] });
    }
    if (req.url.endsWith('/audio/speech')) {
      res.writeHead(200, { 'Content-Type':'audio/mpeg' });
      return res.end('ID3fixture');
    }
    return fixtureResponse(res, 404, { error:{ message:'unexpected request' } });
  });
  const port = await freePort();
  const dshPort = await freePort();
  const origin = 'http://127.0.0.1:' + port;
  const upstreamURL = 'http://127.0.0.1:' + upstream.address().port;
  let child;
  t.after(async () => {
    await stop(child);
    await new Promise(resolve => upstream.close(resolve));
    await rm(directory, { recursive:true, force:true });
  });
  async function boot() {
    child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning','server.mjs'], {
      env:{ ...process.env, GREENROOM_DATA:directory, GREENROOM_PORT:String(port), GREENROOM_DSH_PORT:String(dshPort) },
      stdio:['ignore','pipe','inherit'],
    });
    await ready(child);
  }
  async function call(path, { method = 'GET', body, headers, status = 200 } = {}) {
    const response = await fetch(origin + path, { method, headers:{ ...headers,
      ...(body === undefined ? {} : { 'Content-Type':'application/json' }) },
      body:body === undefined ? undefined : JSON.stringify(body),
    });
    assert.equal(response.status, status, path);
    return response.json();
  }
  await boot();
  const provider = async (name, suffix, scope, protocol = 'responses') =>
    (await call('/api/providers', { method:'POST', status:201,
      body:{ name, url:upstreamURL + suffix, key:fixtureKey + suffix, scope, protocol } })).id;
  const primary = await provider('默认供应商','/v1',['text','image','audio']);
  const image = await provider('生图供应商','/image/v1',['image']);
  const voice = await provider('音频供应商','/voice/v1',['audio']);
  const extra = await provider('文字兼容','/extra/v1',['text'],'completions');
  const providers = await call('/api/providers');
  assert.equal(providers.defaultId, primary);
  assert.doesNotMatch(JSON.stringify(providers), /fixture-local-key/);
  const dbBytes = await readFile(join(directory,'workspace.sqlite'));
  assert.equal(dbBytes.includes(fixtureKey), false);
  assert.deepEqual(new Set((await call('/api/providers/' + primary + '/models')).map(model => model.kind)),
    new Set(['text','image','audio','video','embedding']));
  const initial = await call('/api/plugins');
  assert.equal(initial.length, 23);
  assert.equal(initial.find(row => row.id === 'huobao').mode, 'restricted');
  assert.equal(initial.find(row => row.id === 'moyin').mode, 'separate');
  await call('/api/plugins/t8', { method:'PUT', body:{ url:'http://127.0.0.1:19000', bindings:{ text:extra, image, audio:voice } } });
  await call('/api/plugins/t8', { method:'PUT', status:422, body:{ bindings:{ image:extra } } });
  await call('/api/plugins/openslop', { method:'PUT', status:422, body:{ url:'https://external.example', bindings:{} } });
  const key = await readFile(join(directory,'key'));
  const t8Header = { Authorization:'Bearer ' + bridgeKey(key, 't8') };
  await call('/gateway/t8/v1/models', { headers:{ Authorization:'Bearer ' + bridgeKey(key,'dsh') }, status:401 });
  assert.deepEqual(new Set((await call('/gateway/t8/v1/models', { headers:t8Header })).data.map(row => row.id)),
    new Set(['gpt-6-luna','gpt-image-2.6-flare','tts-1']));
  for (const [path, body] of [
    ['/chat/completions',{ model:'gpt-6-luna', messages:[{ role:'user', content:'测试' }] }],
    ['/images/generations',{ model:'gpt-image-2.6-flare', prompt:'红伞' }],
  ]) await call('/gateway/t8/v1' + path, { method:'POST', headers:t8Header, body });
  assert.equal(upstreamCalls.at(-2).path, '/extra/v1/chat/completions');
  assert.equal(upstreamCalls.at(-1).path, '/image/v1/images/generations');
  if (process.env.GREENROOM_TEST_T8_SOURCE) {
    const require = createRequire(import.meta.url);
    const t8 = require(join(process.env.GREENROOM_TEST_T8_SOURCE,'backend/src/providers/openaiCompatible.js'));
    const configured = { id:'greenroom', protocol:'openai-compatible', baseUrl:origin + '/gateway/t8/v1',
      apiKey:bridgeKey(key,'t8'), imageModels:['gpt-image-2.6-flare'] };
    const actual = await t8.generateImage(configured, { prompt:'雨后红伞', size:'1024x1024', quality:'low', n:1 });
    assert.equal(actual.ok, true, actual.error);
    assert.match(actual.imageUrls[0], /^data:image\/png;base64,/);
    assert.equal(upstreamCalls.at(-1).path,'/image/v1/images/generations');
  }

  if (process.env.GREENROOM_TEST_T8_URL) {
    const t8Origin = new URL(process.env.GREENROOM_TEST_T8_URL);
    assert.equal(t8Origin.hostname, '127.0.0.1');
    const response = await fetch(new URL('/api/proxy/external/image', t8Origin), {
      method:'POST', headers:{ 'Content-Type':'application/json' }, body:JSON.stringify({
        provider:{ id:'greenroom-acceptance', name:'Greenroom', protocol:'openai-compatible', enabled:true,
          baseUrl:origin + '/gateway/t8/v1', apiKey:bridgeKey(key,'t8'), imageModels:['gpt-image-2.6-flare'] },
        model:'gpt-image-2.6-flare', prompt:'雨后红伞',
      }),
    });
    const output = await response.json();
    assert.equal(output.success, true, output.error);
    assert.equal(output.data.imageUrls.length, 1);
    const media = await fetch(new URL(output.data.imageUrls[0], t8Origin));
    assert.equal(media.status, 200);
    assert.deepEqual(Buffer.from(await media.arrayBuffer()), Buffer.from(pngBase64,'base64'));
    const imageRequest = upstreamCalls.at(-1).body;
    assert.deepEqual([imageRequest.size,imageRequest.quality,imageRequest.n],['1024x1024','low',1]);
  }

  const project = await call('/api/projects', { method:'POST', status:201, body:{ name:'雨后车站' } });
  const submit = (kind, model, prompt, options) => call('/api/projects/' + project.id + '/tasks', {
    method:'POST', status:201, body:{ kind, model, prompt, options },
  });
  const draft = await submit('text','gpt-6-luna','雨后开场',{ effort:'low' });
  assert.equal(draft.content, '雨后的车站。');
  assert.equal(upstreamCalls.at(-1).body.reasoning.effort, 'low');
  const picture = await submit('image','gpt-image-2.6-flare','红伞');
  const originalImage = upstreamCalls.at(-1).body;
  assert.deepEqual([originalImage.size,originalImage.quality,originalImage.n], ['1024x1024','low',1]);
  assert.deepEqual(Buffer.from(await (await fetch(origin + '/api/media/' + picture.id)).arrayBuffer()),
    Buffer.from(pngBase64,'base64'));
  const speech = await submit('audio','tts-1','最后一班列车');
  assert.equal(await (await fetch(origin + '/api/media/' + speech.id)).text(), 'ID3fixture');
  assert.equal(upstreamCalls.at(-1).body.voice, 'alloy');
  const refused = await submit('text','gpt-6-luna','拒绝样本');
  assert.equal(refused.status, 'failed');
  assert.doesNotMatch(refused.error, /fixture-local-key/);
  const background = await submit('text','gpt-6-luna','后台任务',{ background:true });
  assert.equal(background.status,'running');
  assert.equal(background.upstream_id,'resp_original');

  await call('/api/providers/' + primary, { method:'PUT', body:{
    name:'新网关', url:upstreamURL + '/changed/v1', key:'different-key', scope:['text','image','audio'], protocol:'completions',
  } });
  await stop(child);
  await boot();
  const poll = () => call('/api/tasks/' + background.id + '/poll', { method:'POST', body:{} });
  const unconfirmed = await poll();
  assert.equal(unconfirmed.status,'running');
  assert.match(unconfirmed.query_error, /503/);
  failQuery = false;
  const completed = await poll();
  assert.deepEqual([completed.status, completed.provider_name, completed.content],
    ['done','默认供应商','原任务完成。']);
  assert.equal(upstreamCalls.at(-1).path,'/v1/responses/resp_original');
  assert.equal(upstreamCalls.at(-1).key,'Bearer ' + fixtureKey + '/v1');
  assert.equal(upstreamCalls.filter(row => row.body?.background).length,1);

  const mcp = new Client({ name:'greenroom-acceptance', version:'1.0.0' });
  const dshHeaders = { Authorization:'Bearer ' + bridgeKey(key,'dsh') };
  await mcp.connect(new StreamableHTTPClientTransport(new URL(origin + '/mcp'), {
    requestInit:{ headers:dshHeaders },
  }));
  try {
    assert.deepEqual((await mcp.listTools()).tools.map(tool => tool.name),
      ['projects','history','media','task_status','plugins']);
    const fromDsh = await mcp.callTool({ name:'projects', arguments:{} });
    assert.equal(fromDsh.structuredContent.result[0].id, project.id);
    await call('/api/plugins/dsh', { method:'PUT', body:{ bindings:{ audio: voice, text:extra } } });
    const created = await mcp.callTool({ name:'media', arguments:{
      projectId:project.id, kind:'audio', model:'tts-1', prompt:'配音接入',
    } });
    assert.equal(created.structuredContent.result.status, 'done');
    assert.equal(upstreamCalls.at(-1).path,'/voice/v1/audio/speech');
  } finally { await mcp.close(); }

  const harness = await call('/api/harness', { method:'POST', body:{} });
  assert.equal(harness.status, 'ready', harness.issue);
  assert.equal(harness.version,'0.2.2-rc.5');
  assert.equal(harness.model,'gpt-6-luna');
  assert.equal(new URL(harness.url).port,String(dshPort));
  assert.equal((await fetch('http://127.0.0.1:' + dshPort)).status,401);
  const login = await fetch(harness.url, { redirect:'manual' });
  assert.equal(login.status,303);
  const cookie = login.headers.getSetCookie()[0].split(';')[0];
  const root = await fetch('http://127.0.0.1:' + dshPort, { headers:{ Cookie:cookie } });
  assert.equal(root.status,200);
  assert.match(await root.text(), /DeepSeek Harness/);
  const cli = join(process.cwd(),'node_modules/@deepseek-ai/dsh/lib/bin.js');
  const output = await promisify(execFile)(process.execPath, [cli,'--profile','headless','--patch',
    join(directory,'dsh/greenroom.overlay.yml'),'只需回复一行验收文字。'], {
    cwd:join(directory,'dsh-workspace'), timeout:25_000, maxBuffer:1024 * 1024,
    env:{ ...process.env, DSH_HOME:join(directory,'headless'), GREENROOM_BRIDGE_KEY:bridgeKey(key,'dsh') },
  });
  assert.match(output.stdout, /官方 DSH 回复通过/);
  assert.ok(upstreamCalls.some(row => row.path === '/extra/v1/chat/completions' && row.body?.stream === true));
});
