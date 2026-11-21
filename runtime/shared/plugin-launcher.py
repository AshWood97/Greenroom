"""Loopback supervisor for Python-only plugin images; original workers stay unchanged."""
import argparse
from concurrent.futures import Future
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
import signal
import subprocess
import threading
import time
import urllib.request
import uuid

parser = argparse.ArgumentParser()
parser.add_argument('--port', type=int, required=True)
parser.add_argument('--ready-url', required=True)
parser.add_argument('command', nargs=argparse.REMAINDER)
args = parser.parse_args()
command = args.command[1:] if args.command[:1] == ['--'] else args.command
lock = threading.Lock()
child = None
starting = None
stopping = False
state = 'sleeping'
error = None
memory_enabled = os.environ.get('MEMBER_MEMORY_ENABLED', '').strip().lower() in {'1', 'true', 'yes', 'on'}
pod_uid = os.environ.get('GREENROOM_POD_UID', '')
plugin_id = os.environ.get('GREENROOM_PLUGIN_ID', '')
instance_id = str(uuid.uuid4())
drain_epoch = 0
reopen_epoch = 0


def memory_current():
    try:
        with open('/sys/fs/cgroup/memory.current', encoding='ascii') as stream:
            value = int(stream.read().strip())
        return value if value > 0 else None
    except (OSError, ValueError):
        return None


def memory_admit():
    if not memory_enabled:
        return True
    with lock:
        if drain_epoch:
            raise RuntimeError('成员运行环境正在调整，请稍后重试')
    if not pod_uid or not plugin_id:
        raise RuntimeError('成员内存配置尚未就绪')
    body = json.dumps({'podUid': pod_uid, 'pluginId': plugin_id}).encode()
    request = urllib.request.Request('http://127.0.0.1:3081/internal/memory/admit', data=body,
                                     headers={'Content-Type': 'application/json'}, method='POST')
    with urllib.request.urlopen(request, timeout=45) as response:
        result = json.loads(response.read(1024))
        if response.status == 202 and result.get('waiting') is True:
            return False
    if result.get('admitted') is not True:
        raise RuntimeError('成员内存申请失败')
    with lock:
        if drain_epoch:
            raise RuntimeError('成员运行环境正在调整，请稍后重试')
    return True


def status():
    global child, state, error
    if child and child.poll() is not None:
        child = None
        state, error = 'failed', '插件业务进程已退出'
    return {'ready': True, 'lifecycle': state, **({'error': error} if error else {}),
            **({'memory_enabled': True, 'pod_uid': pod_uid, 'plugin_id': plugin_id,
                'instance_id': instance_id, 'drain_epoch': drain_epoch,
                'memory_current_bytes': memory_current()} if memory_enabled else {})}


def terminate():
    global child
    running = child
    if running and running.poll() is None:
        os.killpg(running.pid, signal.SIGTERM)
        try:
            running.wait(timeout=10)
        except subprocess.TimeoutExpired:
            os.killpg(running.pid, signal.SIGKILL)
            running.wait()
    child = None


def boot(future):
    global child, starting, state, error
    try:
        if not memory_admit():
            state, error = 'sleeping', None
            future.set_result({**status(), 'waiting': True})
            return
        with lock:
            if memory_enabled and drain_epoch:
                raise RuntimeError('成员运行环境正在调整，请稍后重试')
            child = subprocess.Popen(command, start_new_session=True)
        deadline = time.monotonic() + 45
        while time.monotonic() < deadline:
            if child.poll() is not None:
                raise RuntimeError('插件业务进程已退出')
            try:
                with urllib.request.urlopen(args.ready_url, timeout=1) as response:
                    if response.status == 200:
                        state, error = 'ready', None
                        future.set_result(status())
                        return
            except (OSError, urllib.error.URLError):
                pass
            time.sleep(0.1)
        raise RuntimeError('插件启动超过 45 秒')
    except Exception as failure:
        terminate()
        state, error = 'failed', str(failure)
        future.set_exception(failure)
    finally:
        with lock:
            starting = None


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def send(self, code, value):
        body = json.dumps(value, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(body)

    def allowed(self):
        if self.headers.get('Origin') or self.client_address[0] != '127.0.0.1':
            self.send(403, {'error': '仅允许成员环境内部访问'})
            return False
        return True

    def do_GET(self):
        if self.allowed():
            self.send(200, status()) if self.path in ('/health', '/state') else self.send(404, {})

    def do_POST(self):
        global starting, stopping, state, error, drain_epoch, reopen_epoch
        if not self.allowed():
            return
        try:
            if self.path == '/start':
                with lock:
                    if memory_enabled and drain_epoch:
                        return self.send(409, {'error': '成员运行环境正在调整，请稍后重试'})
                    if stopping:
                        return self.send(409, {'error': '插件正在休眠'})
                    ready = status()['lifecycle'] == 'ready'
                    if not ready and starting is None:
                        starting = Future()
                        state, error = 'starting', None
                        threading.Thread(target=boot, args=(starting,), daemon=True).start()
                    future = starting
                if ready:
                    admitted = memory_admit()
                    return self.send(200, status() if admitted else {**status(), 'waiting': True})
                return self.send(200, future.result())
            if self.path == '/stop':
                length = int(self.headers.get('Content-Length', '0'))
                if length > 1024:
                    return self.send(413, {})
                body = json.loads(self.rfile.read(length) or b'{}')
                with lock:
                    if body.get('idle') is not True or starting or stopping:
                        return self.send(409, {'error': '尚未确认插件空闲'})
                    stopping = True
                try:
                    terminate()
                    state, error = 'sleeping', None
                    return self.send(200, status())
                finally:
                    stopping = False
            if memory_enabled and self.path in ('/drain', '/reopen'):
                length = int(self.headers.get('Content-Length', '0'))
                if length > 1024:
                    return self.send(413, {})
                payload = json.loads(self.rfile.read(length) or b'{}')
                epoch = payload.get('epoch')
                if (payload.get('pod_uid') != pod_uid or payload.get('plugin_id') != plugin_id
                        or payload.get('instance_id') != instance_id):
                    return self.send(409, {})
                if not isinstance(epoch, int) or isinstance(epoch, bool) or epoch < 1:
                    return self.send(409, {})
                with lock:
                    if self.path == '/drain':
                        if epoch < drain_epoch or epoch <= reopen_epoch:
                            return self.send(409, {})
                        drain_epoch = epoch
                        return self.send(200, {**status(), 'epoch': epoch, 'closed': True})
                    if (drain_epoch and epoch <= drain_epoch) or epoch < reopen_epoch:
                        return self.send(409, {})
                    reopen_epoch, drain_epoch = epoch, 0
                    return self.send(200, {**status(), 'epoch': epoch, 'opened': True})
            self.send(404, {})
        except Exception as failure:
            self.send(503, {**status(), 'error': str(failure)})


server = ThreadingHTTPServer(('127.0.0.1', args.port), Handler)
server.daemon_threads = True


def shutdown(*_):
    terminate()
    os._exit(0)


signal.signal(signal.SIGTERM, shutdown)
signal.signal(signal.SIGINT, shutdown)
server.serve_forever()
