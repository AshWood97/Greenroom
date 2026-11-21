"""Python 插件共享的托管桥接规则（moneyprinter / arcreel 等容器内使用）。

只承载各插件原本重复实现的两个纯函数：桥接错误信息归一化、任务产物挑选。
各插件经 prepare.mjs 把本文件复制为 greenroom_bridge.py 放入自己的运行根目录；
本文件不依赖任何第三方库，也不感知具体插件的业务与存储。
"""


def bridge_error_message(result, status=0):
    """把桥接/平台返回的错误结构归一成单条中文消息。

    兼容 error/message/detail 字符串或 {message|error|reason, code} 结构；
    code 非空时追加 [code]，HTTP status >= 400 时追加 (HTTP status)。
    """
    value = result.get('error') or result.get('message') or result.get('detail') or ''
    if isinstance(value, dict):
        text = value.get('message') or value.get('error') or value.get('reason') or ''
        code = value.get('code')
    else:
        text, code = str(value), result.get('code')
    text = text or '服务商未返回具体失败原因'
    if code not in (None, '', 0, '0'):
        text += f' [{code}]'
    if status >= 400:
        text += f' (HTTP {status})'
    return text


def pick_task_output(task, kind):
    """从平台任务 outputs 中取第一个匹配媒体类型的产物。

    返回 (asset_id, url)；asset_id 缺失时从 url 尾段推导；没有匹配返回 None。
    """
    for item in (task or {}).get('outputs', []) or []:
        if str(item.get('mimeType', '')).startswith(kind + '/'):
            url = item.get('url') or ''
            return item.get('assetId') or (url.rsplit('/', 1)[-1] if url else ''), url
    return None
