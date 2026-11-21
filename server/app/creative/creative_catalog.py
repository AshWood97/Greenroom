"""The two approved release batches share one catalog across build and runtime."""
import json
from pathlib import Path

PLUGIN_ROOT = Path(__file__).resolve().parents[3] / 'runtime' / 'creative-plugins'


def creative_catalog():
    return json.loads((PLUGIN_ROOT / 'catalog.json').read_text())


def plugin_enabled(plugin, catalog):
    if plugin.get('status') == 'awaiting-authorization':
        return False
    return bool(plugin.get('builtin') or catalog.get(
        'aigcSkillsReady' if plugin.get('releaseBatch') == 'aigc-skills' else 'releaseReady'))


def runtime_manifests():
    catalog = creative_catalog()
    manifests = [json.loads((PLUGIN_ROOT / row['id'] / 'manifest.json').read_text())
                 for row in catalog['plugins'] if not row.get('builtin') and plugin_enabled(row, catalog)]
    return [row for row in manifests if row.get('runtime')]
