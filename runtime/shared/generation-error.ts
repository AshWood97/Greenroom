/** Shared by the managed creation plugins. Keep the provider's cause visible. */
const reasonKeys = [
  'error_message', 'errorMessage', 'error_msg', 'errorMsg', 'exception_message',
  'message', 'msg', 'error', 'detail', 'failReason', 'failedReason', 'fail_reason',
  'reason', 'description',
] as const;

function clean(text: string): string {
  return text
    .replace(/(\bE[A-Z0-9_]+:\s*[^\n]*?,\s*(?:open|stat|lstat|readlink|scandir|unlink|mkdir|access|rename|copyfile))\s+['"][^\n]*['"]/g, '$1 [local path hidden]')
    .replace(/data:[^\s;,]+;base64,[A-Za-z0-9+/=]+/gi, '[media data hidden]')
    .replace(/[A-Za-z0-9+/=]{512,}/g, '[long encoded data hidden]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer ***')
    .replace(/(["']?(?:api[ _-]?key|access[_-]?token|refresh[_-]?token|token|authorization|password|client[_-]?secret|secret)["']?\s*[:=]\s*)["']?[^\s,"';&}]+["']?/gi, '$1***')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, '***')
    .replace(/https?:\/\/[^\s<>"']+/gi, value => {
      try {
        const url = new URL(value);
        url.username = '';
        url.password = '';
        const privateSuffix = Boolean(url.search || url.hash);
        url.search = '';
        url.hash = '';
        return url.toString() + (privateSuffix ? '?***' : '');
      } catch {
        return value.replace(/(https?:\/\/)[^/@]*@/i, '$1').replace(/[?#].*$/, '?***');
      }
    })
    .replace(/\n\s*(?:at\s+|Traceback\b)[\s\S]*$/, '')
    .trim();
}

/** Extract only error fields, never stringify an entire provider response. */
export function generationErrorText(value: unknown): string {
  const seen = new Set<object>();
  function visit(candidate: unknown): string {
    if (typeof candidate === 'string') {
      const text = candidate.trim();
      const wrapped = text.match(/^(?:API error\s+|HTTP\s+)(\d{3})\s*:\s*([\s\S]*)$/i);
      const raw = wrapped ? wrapped[2] : text;
      if (/^[\[{]/.test(raw)) {
        try {
          const parsed = visit(JSON.parse(raw));
          return wrapped ? `HTTP ${wrapped[1]}: ${parsed}` : parsed;
        } catch { /* Not JSON: preserve the actual error text. */ }
      }
      if (/^\s*<(?:!doctype|html)\b/i.test(raw)) return wrapped ? `HTTP ${wrapped[1]}: 服务商返回非 JSON 响应` : '';
      return text;
    }
    if (typeof candidate === 'number') return String(candidate);
    if (!candidate || typeof candidate !== 'object' || seen.has(candidate)) return '';
    seen.add(candidate);
    if (Array.isArray(candidate)) {
      return candidate.map(visit).find(Boolean) || '';
    }
    const record = candidate as Record<string, unknown>;
    let message = '';
    for (const key of reasonKeys) {
      message = visit(record[key]);
      if (message) break;
    }
    const code = record.error_code ?? record.errorCode ?? record.code;
    if ((typeof code === 'string' || typeof code === 'number') && code !== '' && code !== 0 && code !== '0') {
      const text = String(code);
      if (message !== text && !message.includes(`[${text}]`)) message += `${message ? ' ' : ''}[${text}]`;
    }
    const status = record.httpStatus ?? record.status;
    if (typeof status === 'number' && status >= 400 && status <= 599 && !message.includes(`HTTP ${status}`)) {
      message += `${message ? ' ' : ''}(HTTP ${status})`;
    }
    return message;
  }
  return clean(visit(value));
}

const chineseReasons: Array<[RegExp, string]> = [
  [/\b(?:ENAMETOOLONG|ENOENT|EACCES|EPERM|EISDIR|ENOTDIR)\b/, '本地素材读取失败'],
  [/billing[._]balance_insufficient|insufficient[ _](?:balance|funds|credits)|balance[ _]insufficient|\[(?:416|812)\]/i, '生成服务余额不足'],
  [/concurrency|concurrent[ _](?:limit|requests|tasks)/i, '生成任务超过服务商并发限制'],
  [/ratelimit|rate[ _]limit|too many requests|HTTP 429/i, '生成请求触发服务商限流'],
  [/input[._ ]moderation|input.*(?:content.?filter|safety.*reject)/i, '输入内容未通过服务商审核'],
  [/output[._ ]moderation|output.*(?:content.?filter|safety.*reject)/i, '生成内容未通过服务商审核'],
  [/moderation|content[._ ]filter|safety[._ ](?:check|violation)|nsfw/i, '内容未通过服务商审核'],
  [/access\.unauthorized|invalid[ _]api[ _]key|authentication|unauthorized|HTTP 401/i, '生成服务认证失败'],
  [/access\.forbidden|permission denied|forbidden|HTTP 403/i, '生成服务拒绝了当前请求权限'],
  [/model[._ ](?:not[._ ]found|unavailable)|unsupported[ _]model|model.*not.*(?:available|exist)/i, '所选生成模型不可用'],
  [/missing[ _](?:field|parameter|required)|(?:field|parameter).*required/i, '缺少生成所需参数'],
  [/validation|invalid[ _](?:argument|parameter|field|size|duration|resolution)|unsupported[ _](?:parameter|resolution|size)|must be|HTTP (?:400|422)/i, '生成参数不符合模型要求'],
  [/timed?\s*out|timeout|deadline exceeded|HTTP (?:408|504)/i, '生成服务请求超时'],
  [/fetch failed|network error|ECONNREFUSED|ENOTFOUND|connection (?:failed|refused|reset)/i, '无法连接生成服务'],
  [/download failed|output.*(?:missing|not found)|no.*output/i, '生成产物读取失败'],
  [/HTTP 5\d\d|service unavailable|bad gateway|internal server error/i, '生成服务发生异常'],
];

/** Display a Chinese cause and the cleaned original without adding advice. */
export function formatGenerationError(value: unknown, fallback = ''): string {
  const reason = generationErrorText(value) || generationErrorText(fallback);
  if (!reason) return '中文原因：服务商未返回具体失败原因';
  // Several existing views format a stored error again when restoring a task.
  if (reason.includes('中文原因：')) return reason;
  if (/^(?:生成失败|操作失败(?:[，,]?\s*请重试)?|未知错误|unknown error|generation failed|failed)$/i.test(reason)) {
    return `中文原因：服务商未返回具体失败原因\n上游原因：${reason}`;
  }
  if (/[\u3400-\u9fff]/.test(reason)) return `中文原因：${reason}`;
  const chinese = chineseReasons.find(([pattern]) => pattern.test(reason))?.[1]
    || '服务商返回错误，具体分类未知';
  return `中文原因：${chinese}\n上游原因：${reason}`;
}
