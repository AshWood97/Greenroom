// Managed drama amounts are projections of Starnet receipts in micro-CNY,
// not balances or prices in the upstream application's credit system.
export function prepareManagedUI(patch) {
  // Hide only native wallet entry points; task receipts and the global feature
  // response remain unchanged, including pending/unknown Starnet amounts.
  for (const file of [
    'web/src/components/layout/workspace-sidebar-checkin.tsx',
    'web/src/components/layout/workspace-sidebar-footer.tsx',
    'web/src/components/layout/workspace-account-card.tsx',
    'web/src/components/layout/workspace-top-bar.tsx',
    'web/src/pages/canvas/canvas-project-top-bar.tsx',
  ]) patch(file, '    const creditsEnabled = useUserStore((state) => state.features.creditsEnabled);', '    const creditsEnabled = false; // Native credit wallet is not the Greenroom balance.');
  patch('web/src/components/layout/workspace-command-palette.tsx', '            ...(features.creditsEnabled ? [{ ...toolEntry("wallet"), run: () => openWorkspaceWallet() }] : []),\n', '');
  patch('web/src/components/layout/workspace-command-palette.tsx', 'import { openWorkspaceWallet } from "@/lib/workspace-wallet";\n', '');
  patch('web/src/components/layout/workspace-wallet-modal.tsx', 'export function WorkspaceWalletModal({', `export function WorkspaceWalletModal({ open, onClose }: Parameters<typeof UnmanagedWorkspaceWalletModal>[0]) {
    return <AppModal open={open} onCancel={onClose} footer={null} title="平台统一计费">
        <p>生成费用由星网统一结算，请在 Greenroom 查看余额与账单。未确认费用以实际回执为准。</p>
    </AppModal>;
}

function UnmanagedWorkspaceWalletModal({`);
  patch('web/src/lib/drama/drama-format.ts', `    const credits = microcredits / 1_000_000;
    if (credits >= 10_000) return \`\${(credits / 10_000).toFixed(credits >= 100_000 ? 0 : 1)}万\`;
    return credits.toLocaleString("zh-CN", { maximumFractionDigits: credits >= 100 ? 0 : 2 });`, `    if (!Number.isFinite(microcredits)) return "费用待确认";
    return "¥" + (microcredits / 1_000_000).toLocaleString("zh-CN", { maximumFractionDigits: 6 });`);
  patch('web/src/lib/drama/drama-format.ts', 'export function formatDramaCredits', `export function formatDramaTaskCost(amount: number, confirmed: boolean | undefined, status: string, taskId?: string) {
    if (status === "queued" || status === "running") return "生成中/费用待确认";
    if (!taskId) return "未提交生成请求";
    return confirmed === true ? formatDramaCredits(amount) : "费用待确认";
}

export function formatDramaCredits`);
  patch('web/src/pages/projects/drama-shared.tsx', 'formatDramaCredits as formatCredits }', 'formatDramaCredits as formatCredits, formatDramaTaskCost as formatTaskCost }');
  const api = 'web/src/services/api/drama.ts';
  patch(api, '    costMicrocredits: number;\n    attempt: number;', '    costMicrocredits: number;\n    costConfirmed?: boolean;\n    attempt: number;');
  patch(api, 'error?: string; costMicrocredits: number; at: string;', 'error?: string; costMicrocredits: number; costConfirmed?: boolean; at: string;');

  const create = 'web/src/pages/projects/create.tsx';
  patch(create, '每一步可以单独设置思考意图、文本模型和写作技能；思考档位按实际使用模型归一', '每一步可选择文本模型和写作技能。星网尚未提供该模型的思考档位能力；请选择“自动”，或等待管理员完成能力接入。明确选择关闭或其他档位会被拒绝，不会自动换档。');
  patch(create, 'App, Button, Input, InputNumber, Select', 'App, Button, Input, Select');
  patch(create, 'useState<DramaVideoContinuity>("tail_frame")', 'useState<DramaVideoContinuity>("parallel")');
  patch(create, '    const [budgetCredits, setBudgetCredits] = useState<number | null>(null);\n', '');
  patch(create, `    useEffect(() => {
        if (estimate && budgetCredits === null && estimate.maxMicrocredits > 0) setBudgetCredits(Math.ceil(estimate.maxMicrocredits / 1_000_000));
    }, [estimate, budgetCredits]);
`, '');
  patch(create, '        setBudgetCredits(null);\n', '');
  patch(create, '        setBudgetCredits(Math.ceil(draft.budgetMicrocredits / 1_000_000));\n', '');
  patch(create, 'budgetMicrocredits: Math.max(0, Math.round((budgetCredits || 0) * 1_000_000)),', 'budgetMicrocredits: 0,');
  patch(create, `                        <div className="drama-field">
                            <div className="drama-field-label">
                                <span>预算上限</span>
                                <small>留空或 0 为不限，达到后自动暂停</small>
                            </div>
                            <InputNumber className="!w-full" min={0} precision={0} value={budgetCredits} onChange={(value) => setBudgetCredits(value ?? 0)} suffix="积分" aria-label="预算上限" />
                        </div>`, '                        <p className="drama-cfg-note">由星网网关计费，实际费用以平台结算回执为准；这里不设置独立积分钱包或预算。</p>');
  patch(create, '`${formatCredits(estimate.minMicrocredits)}–${formatCredits(estimate.maxMicrocredits)}` : "—"', '`${formatCredits(estimate.minMicrocredits)}–${formatCredits(estimate.maxMicrocredits)}` : "费用待确认"');
  patch(create, '<span>预计积分</span>', '<span>预计费用（非扣费回执）</span>');
  patch(create, '{formatCredits(estimate.sampleMicrocredits)} 积分', '{formatCredits(estimate.sampleMicrocredits)}');

  const settings = 'web/src/pages/projects/studio/panels.tsx';
  patch(settings, '每一步可以单独设置思考意图、文本模型和写作技能；思考等级按实际使用模型的能力归一化，对之后执行的步骤生效', '模型和写作技能设置对之后执行的步骤生效。星网尚未提供该模型的思考档位能力；请选择“自动”，或等待管理员完成能力接入。明确选择关闭或其他档位会被拒绝，不会自动换档。');
  patch(settings, 'settings.videoContinuity || "tail_frame"', 'settings.videoContinuity || "parallel"');
  patch(settings, 'detail="只列出平台可无人值守执行的模型"', 'detail="星网请求参数；模型支持由网关实际校验"');
  patch(settings, 'EpisodeGroupField, formatCredits, MEDIA_MODE_LABEL', 'EpisodeGroupField, MEDIA_MODE_LABEL');
  patch(settings, 'import { progressFillStyle } from "@/lib/progress-fill";\n', '');
  patch(settings, '    const [budget, setBudget] = useState(summary.production.budgetMicrocredits / 1_000_000);\n', '');
  patch(settings, '        setBudget(summary.production.budgetMicrocredits / 1_000_000);\n', '');
  patch(settings, '    }, [summary.production.settings, summary.production.budgetMicrocredits]);', '    }, [summary.production.settings]);');
  patch(settings, 'JSON.stringify(settings) !== JSON.stringify(current) || Math.round(budget * 1_000_000) !== summary.production.budgetMicrocredits, [budget, current, settings, summary.production.budgetMicrocredits]', 'JSON.stringify(settings) !== JSON.stringify(current), [current, settings]');
  patch(settings, 'updateDramaSettings(projectId, { settings, budgetMicrocredits: Math.max(0, Math.round((budget || 0) * 1_000_000)) })', 'updateDramaSettings(projectId, { settings })');
  patch(settings, '    const held = summary.production.heldMicrocredits || 0;\n    const budgetMicro = Math.round((budget || 0) * 1_000_000);\n    // 预算占用与后端判断同一口径：已扣费加冻结中的订单。\n    const usage = budgetMicro > 0 ? Math.min(1, (spent + held) / budgetMicro) : 0;\n', '');
  patch(settings, '    const spent = summary.production.spentMicrocredits;\n', '');
  patch(settings, '                                setBudget(summary.production.budgetMicrocredits / 1_000_000);\n', '');
  patch(settings, `                                <SettingsTitle title="预算上限" detail="0 表示不限，含精修画布花费；达到后暂停，画布上也不能再生成" />
                                <InputNumber className="!w-full" min={0} precision={0} value={budget} onChange={(value) => setBudget(value || 0)} suffix="积分" aria-label="预算上限" />
                                <div className="drama-budget-meter">
                                    <div className="drama-budget-track">
                                        <span className={usage >= 0.9 ? "is-warn" : ""} style={progressFillStyle(budgetMicro ? Math.max(usage * 100, spent + held ? 2 : 0) : 0)} />
                                    </div>
                                    <span>
                                        已花费 <b>{formatCredits(spent)}</b>
                                        {held > 0 ? \` · 冻结中 \${formatCredits(held)}\` : ""}
                                        {budgetMicro ? \` / \${formatCredits(budgetMicro)}\` : " · 不限预算"}
                                    </span>
                                </div>`, '                                <SettingsTitle title="星网费用" detail="累计费用以星网账单为准；单项已确认费用可在任务详情查看" />');
  patch(settings, `                                {summary.production.canvasSpentMicrocredits > 0 ? (
                                    <p className="drama-cfg-note">
                                        其中流水线 {formatCredits(Math.max(0, spent - summary.production.canvasSpentMicrocredits))}，精修画布 {formatCredits(summary.production.canvasSpentMicrocredits)}。
                                    </p>
                                ) : null}`, '');

  const queue = 'web/src/pages/projects/studio/queue-bar.tsx';
  patch(queue, 'import { formatCredits }', 'import { formatTaskCost }');
  patch(queue, '    const budget = production.budgetMicrocredits;\n    const held = production.heldMicrocredits || 0;\n    // 预算进度与后端预算判断同一口径：已扣费加未结算订单的冻结额。\n    const committed = production.spentMicrocredits + held;\n    const usage = budget ? Math.min(1, committed / budget) : 0;\n', '');
  patch(queue, `                    {budget ? (
                        <span className="drama-queue-meter">
                            <span className={usage >= 0.9 ? "is-warn" : ""} style={{ width: \`\${Math.max(usage * 100, committed ? 3 : 0)}%\` }} />
                        </span>
                    ) : null}
                    已用 <b>{formatCredits(production.spentMicrocredits)}</b>
                    {held > 0 ? <> · 冻结 {formatCredits(held)}</> : null}
                    {budget ? <> / {formatCredits(budget)} 积分</> : " 积分 · 不限预算"}`, '                    累计费用以星网账单为准');
  patch(queue, '    const { jobCounts, production } = summary;', '    const { jobCounts } = summary;');
  patch(queue, 'job.costMicrocredits ? `${formatCredits(job.costMicrocredits)} 积分` : ""', 'formatTaskCost(job.costMicrocredits, job.costConfirmed, job.status, job.taskId)');

  const detail = 'web/src/pages/projects/studio/job-detail.tsx';
  patch(detail, 'import { formatCredits, MediaThumb', 'import { formatTaskCost, MediaThumb');
  patch(detail, 'current.costMicrocredits ? `${formatCredits(current.costMicrocredits)} 积分` : "0"', 'formatTaskCost(current.costMicrocredits, current.costConfirmed, current.status, current.taskId)');
  patch(detail, '<dt>积分</dt>', '<dt>星网费用</dt>');
  patch(detail, 'attempt.costMicrocredits ? formatCredits(attempt.costMicrocredits) : "0"', 'formatTaskCost(attempt.costMicrocredits, attempt.costConfirmed, attempt.status, attempt.taskId)');

  const segment = 'web/src/pages/projects/studio/segment-dialog.tsx';
  patch(segment, 'CAST_KIND_LABEL, formatCredits, mediaBusy', 'CAST_KIND_LABEL, formatTaskCost, mediaBusy');
  patch(segment, 'segment.videoJob ? `${formatCredits(segment.videoJob.costMicrocredits)} 积分` : "—"', 'segment.videoJob ? formatTaskCost(segment.videoJob.costMicrocredits, segment.videoJob.costConfirmed, segment.videoJob.status, segment.videoJob.taskId) : "未提交生成请求"');

  patch('web/src/pages/projects/index.tsx', 'import { formatCredits, MediaThumb', 'import { MediaThumb');
  patch('web/src/pages/projects/index.tsx', '{item.spentMicrocredits ? <span>{formatCredits(item.spentMicrocredits)} 积分</span> : null}', '<span>累计费用以星网账单为准</span>');
  const sidebar = 'web/src/components/canvas/canvas-drama-sidebar.tsx';
  patch(sidebar, 'dramaCastDisplayName, formatDramaCredits', 'dramaCastDisplayName');
  patch(sidebar, '<span>已用积分</span>', '<span>累计费用以星网账单为准</span>');
  patch(sidebar, `{formatDramaCredits(production.spentMicrocredits)}
                            {production.budgetMicrocredits > 0 ? \` / \${formatDramaCredits(production.budgetMicrocredits)}\` : ""}`, '');
  patch(sidebar, `                    {production.canvasSpentMicrocredits > 0 ? (
                        <div className="flex items-center justify-between gap-2">
                            <span>其中画布精修</span>
                            <span className="tabular-nums">{formatDramaCredits(production.canvasSpentMicrocredits)}</span>
                        </div>
                    ) : null}`, '');
  // The managed duration may be a conservative request default, not a catalog capability.
  const rules = 'web/src/pages/projects/storyboard-rules.tsx';
  patch(rules, '按场景切换与冲突转折切段，单段不超过视频模型单次上限', '按场景切换与冲突转折切段，使用当前请求时长范围');
  patch(rules, '按场景与冲突切段，单段不超过 ${maxVideoSeconds} 秒（${modelName}上限）', '按场景与冲突切段，当前请求每段不超过 ${maxVideoSeconds} 秒（${modelName}；实际支持由网关校验）');
  patch(rules, '按场景与冲突切段，单段不超过视频模型单次上限', '按场景与冲突切段；模型支持时长由网关校验');
  patch(rules, '{modelName}单次最长 {maxVideoSeconds} 秒，', '{modelName}当前请求按 {maxVideoSeconds} 秒限制切段（不代表模型最大能力），');
  patch('web/src/pages/projects/studio/storyboard.tsx', ' · 上限 ${segment.request.maxVideoSeconds}s', ' · 请求切段限制 ${segment.request.maxVideoSeconds}s');

}
