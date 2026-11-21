import json
import os
from pathlib import Path

import httpx
import uvicorn

root = Path(os.environ['GREENROOM_PLUGIN_ROOT']).resolve()
root.mkdir(parents=True, exist_ok=True)
temporary = root / 'runtime' / 'tmp'
temporary.mkdir(parents=True, exist_ok=True)
os.environ['TMPDIR'] = str(temporary)
os.environ['ARCREEL_DATA_DIR'] = str(root)
os.environ['XDG_CACHE_HOME'] = str(root / 'cache')
os.environ['AUTH_ENABLED'] = 'false'
os.environ['ARCREEL_SDK_SESSION_STORE'] = 'off'
managed = os.environ.get('GREENROOM_MANAGED_URL', 'http://127.0.0.1:18767/managed')
catalog, settings, ready = {}, {}, False
try:
    with httpx.Client(timeout=30) as client:
        response = client.get(managed + '/plugins/arcreel/settings')
        response.raise_for_status()
        result = response.json()
        settings = result.get('data', result)
        catalog = settings['catalog']
        if not isinstance(catalog, dict) or not isinstance(settings['models'], dict):
            raise ValueError('ArcReel 模型目录未就绪')
        ready = True
except (httpx.HTTPError, ValueError, KeyError, TypeError, AttributeError):
    catalog, settings = {}, {}
os.environ['GREENROOM_MODELS'] = json.dumps(catalog)
os.environ['GREENROOM_SETTINGS'] = json.dumps(settings)
os.environ['GREENROOM_ARCREEL_CATALOG_READY'] = '1' if ready else '0'
uvicorn.run('server.app:app', host='0.0.0.0', port=18804)
