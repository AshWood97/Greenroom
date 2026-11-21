// Read only registered skill content in the authenticated member's Session composition.
// No file path is accepted or returned; virtual Skills are first-class entries.
export async function readSkillDocument(ctx, sessionId, name, signal) {
  if (typeof sessionId !== 'string' || !sessionId || sessionId.length > 256 || typeof name !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) throw new Error('invalid-request');
  signal?.throwIfAborted();
  const observation = await ctx.sessionQuery.observeSession(sessionId);
  let lease;
  try {
    if (!observation.projections) throw new Error('session-unavailable');
    const live = ctx.agents.get(sessionId);
    const presets = ctx.get('agentPresets');
    const registry = (live ? presets?.serviceFor(live, 'skills') : undefined) ?? ctx.get('skills');
    if (!registry) throw new Error('skill-unavailable');
    if (!live) {
      if (!presets) throw new Error('skill-unavailable');
      lease = await presets.acquireScope(observation.projections.values.agentPreset ?? undefined);
      if (!lease?.key) throw new Error('skill-unavailable');
    }
    const cwd = observation.projections.values.workingDirectory ?? observation.header.cwd;
    const skill = await registry.get(name, { cwd, scope: live ?? lease.key, signal });
    if (!skill || skill.invocation?.userInvocable === false) throw new Error('skill-unavailable');
    return { name: skill.name, description: skill.description, content: skill.content };
  } finally {
    observation[Symbol.dispose]?.();
    await lease?.[Symbol.asyncDispose]?.();
  }
}

export function installSkillDocuments(ctx) {
  ctx.inject(['agents', 'sessionQuery', 'connection'], (ctx) => {
    ctx.effect(() => ctx.connection.fetch.register({
      path: '/api/greenroom/skills/document', methods: ['GET'], requestBody: 'buffered',
      async fetch(request) {
        const url = new URL(request.url);
        const keys = [...url.searchParams.keys()];
        if (keys.length !== 2 || new Set(keys).size !== 2 || !keys.includes('sessionId') || !keys.includes('name')) return Response.json({ error: '请求参数无效' }, { status: 400 });
        try {
          const document = await readSkillDocument(ctx, url.searchParams.get('sessionId'), url.searchParams.get('name'), request.signal);
          return Response.json(document, { headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } });
        } catch {
          return Response.json({ error: '当前会话无法读取此技能说明' }, { status: 404, headers: { 'cache-control': 'no-store' } });
        }
      },
    }), 'greenroom: scoped Skill documents');
  });
}
