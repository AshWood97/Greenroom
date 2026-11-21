"""Run the original API and Streamlit UI behind one member-local port."""
import asyncio
import os
import signal
import subprocess
import sys
from pathlib import Path

import aiohttp
from aiohttp import web

ROOT = Path(os.environ['GREENROOM_PLUGIN_ROOT']).resolve()
BASE = '/plugins/moneyprinter'
children = []

async def proxy(request):
    if request.path == '/health':
        return web.json_response({'status': 'ok', 'app': 'moneyprinter'})
    api = request.path.startswith(('/api/', '/tasks/', '/health'))
    destination = 'http://127.0.0.1:' + ('18902' if api else '18901')
    path = request.path if api else BASE + request.path
    url = destination + path + ('?' + request.query_string if request.query_string else '')
    headers = {key: value for key, value in request.headers.items() if key.lower() not in ('host', 'cookie', 'connection', 'upgrade')}
    async with aiohttp.ClientSession() as client:
        if request.headers.get('Upgrade', '').lower() == 'websocket':
            protocols = tuple(value.strip() for value in request.headers.get('Sec-WebSocket-Protocol', '').split(',') if value.strip())
            async with client.ws_connect(url, headers=headers, protocols=protocols) as upstream:
                browser = web.WebSocketResponse(protocols=(upstream.protocol,) if upstream.protocol else ())
                await browser.prepare(request)
                async def pipe(source, target):
                    async for message in source:
                        if message.type == aiohttp.WSMsgType.TEXT:
                            await target.send_str(message.data)
                        elif message.type == aiohttp.WSMsgType.BINARY:
                            await target.send_bytes(message.data)
                        else:
                            break
                tasks = [asyncio.create_task(pipe(browser, upstream)), asyncio.create_task(pipe(upstream, browser))]
                try:
                    await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
                finally:
                    for task in tasks:
                        task.cancel()
                return browser
        async with client.request(request.method, url, data=request.content.iter_any(), headers=headers, allow_redirects=False) as upstream:
            response = web.StreamResponse(status=upstream.status, headers={key: value for key, value in upstream.headers.items() if key.lower() not in ('transfer-encoding', 'connection', 'content-encoding', 'content-length')})
            await response.prepare(request)
            async for chunk in upstream.content.iter_any():
                await response.write(chunk)
            await response.write_eof()
            return response

async def boot(app):
    ROOT.mkdir(parents=True, exist_ok=True)
    (ROOT / 'tmp').mkdir(exist_ok=True)
    os.environ['TMPDIR'] = str(ROOT / 'tmp')
    os.environ['MPT_HOME'] = str(ROOT)
    os.environ['XDG_CACHE_HOME'] = str(ROOT / 'cache')
    async with aiohttp.ClientSession() as client:
        async with client.get(os.environ.get('GREENROOM_MANAGED_URL', 'http://127.0.0.1:18767/managed') + '/models') as response:
            response.raise_for_status()
            result = await response.json()
            os.environ['GREENROOM_MODELS'] = __import__('json').dumps(result.get('data', result))
        async with client.get(os.environ.get('GREENROOM_MANAGED_URL', 'http://127.0.0.1:18767/managed') + '/plugins/moneyprinter/settings') as response:
            response.raise_for_status()
            result = await response.json()
            os.environ['GREENROOM_SETTINGS'] = __import__('json').dumps(result.get('data', result))
    children.append(subprocess.Popen([sys.executable, '-m', 'uvicorn', 'greenroom_api:app', '--host', '127.0.0.1', '--port', '18902']))
    children.append(subprocess.Popen([sys.executable, '-m', 'streamlit', 'run', 'webui/Main.py', '--server.address', '127.0.0.1', '--server.port', '18901', '--server.baseUrlPath', BASE.lstrip('/'), '--server.headless', 'true', '--browser.gatherUsageStats', 'false', '--server.enableXsrfProtection', 'false', '--server.enableCORS', 'false']))
    yield
    for child in children:
        child.send_signal(signal.SIGTERM)
    for child in children:
        child.wait(timeout=10)

app = web.Application(client_max_size=500*1024*1024)
app.cleanup_ctx.append(boot)
app.router.add_route('*', '/{path:.*}', proxy)
web.run_app(app, host='0.0.0.0', port=18801, access_log=None)
