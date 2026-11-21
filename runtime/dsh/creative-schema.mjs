import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';

// rc.5's validator cannot resolve the local $defs used by ArcReel. Use the
// already-pinned MCP SDK validator for these native schemas, without rewriting them.
export function createReferencedSchemaValidator(inputSchema) {
  let references = 0;
  const check = (node, active = new Set()) => {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return;
    if (Object.hasOwn(node, '$ref')) {
      const ref = node.$ref;
      if (typeof ref !== 'string' || !/^#\/\$defs\/[^/]+$/.test(ref) || /~(?![01])/.test(ref)) {
        throw new Error('不支持的业务 schema 引用（仅允许本地 $defs）');
      }
      const key = ref.slice('#/$defs/'.length).replace(/~1/g, '/').replace(/~0/g, '~');
      if (!Object.hasOwn(inputSchema.$defs || {}, key)) throw new Error('未知业务 schema 引用：' + ref);
      if (active.has(ref)) throw new Error('循环业务 schema 引用：' + ref);
      references++;
      check(inputSchema.$defs[key], new Set([...active, ref]));
    }
    for (const [key, value] of Object.entries(node)) {
      if (['$defs', 'properties', 'patternProperties'].includes(key)) {
        for (const schema of Object.values(value)) check(schema, active);
      } else if (['items', 'additionalProperties'].includes(key)) check(value, active);
      else if (['oneOf', 'anyOf', 'allOf'].includes(key)) value.forEach(schema => check(schema, active));
    }
  };
  check(inputSchema);
  return references ? new AjvJsonSchemaValidator().getValidator(inputSchema) : null;
}
