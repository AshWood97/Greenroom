import { cp, readFile, writeFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareKnowledge } from '../aigc-shared/prepare.mjs';

const integrationRoot = fileURLToPath(new URL('.', import.meta.url));

async function patchSources(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await patchSources(path);
    else if (entry.name.endsWith('.md')) {
      let source = await readFile(path, 'utf8');
      source = source.replaceAll('来源范围与哈希', '来源ID、范围与处理状态')
        .replaceAll('未覆盖内容哈希', '未覆盖的来源ID与范围')
        .replaceAll('内容哈希', '来源ID、范围与处理状态')
        .replaceAll('来源文件哈希', '来源文件revision、ID与范围')
        .replaceAll('文件哈希', '文件revision')
        .replaceAll('新哈希', '新revision')
        .replaceAll('登记与哈希', '来源ID、范围与状态登记')
        .replaceAll('哈希与类型识别', '来源ID、范围与类型识别')
        .replaceAll('输出哈希未变', '输出revision仍与锁定版本一致');
      await writeFile(path, source);
    }
  }
}
await prepareKnowledge({
  root: process.argv[2], id: 'manju-laoli-skill', prefix: 'manju_laoli', productionKinds: [],
  notes: `本套件为1总控+12内部子Skill，用户只说明目标，总控依原路由读取子Skill与references，不用摘要替代原文。Greenroom 在 7.5 主线保留来源于 7.4.26 的海外、解说和 H3 方法与规则，优先于 SLIM 版本删除这些能力的说明。H3 按原生规格编写并通过 write_document 保存投喂稿后使用 validate_feed 运行 H1–H12；compile_feed 与 check_feed_gates 只处理 Seedance 七段式。H3 结构检查不代表完整项目交付验收。六道前置锁和I画风锁必须分别给出选项由用户选择，style_candidates/style_recommendations只提供候选，不自动确认；用户选择后调用mcp__greenroom__manju_laoli_set_locks。所有可执行入口仅使用本套件列出的固定MCP操作；不运行check_package.py或test/self-test等套件维护流程。来源登记使用mcp__greenroom__manju_laoli_register_source，保留source_id、准确范围、读取/提取/合并状态及revision，不计算文件摘要。M0/M1/M2素材形态与原「不持有图、不索图、不缺图阻塞、不伪称核验」规则保留。本插件只输出原生剧本、资产/分镜提示词、投喂稿及离线看板，不提供生成任务工具；情绪曲线为本地matplotlib操作，中文字体由镜像提供。`,
  async patch(root) {
    const retained = join(integrationRoot, 'retained-knowledge');
    for (const name of ['sd-overseas-engine', 'sd-jieshuo-engine']) {
      await cp(join(retained, name), join(root, name), { recursive: true });
    }
    for (const name of ['h3-adapter.md', 'track-routing.md']) {
      await cp(join(retained, 'short-drama-director/references', name), join(root, 'short-drama-director/references', name));
    }
    const slicePath = join(root, 'short-drama-director/scripts/slice_context.py');
    let slicer = await readFile(slicePath, 'utf8');
    if (slicer.includes('def resolve_files(stage, combat="none"') && !slicer.includes('# greenroom-retained-stage-context')) {
      slicer = slicer.replace('def resolve_files(stage, combat="none", model="2.5", source="1", previs=False):',
        '# greenroom-retained-stage-context\ndef resolve_files(stage, combat="none", model="2.5", source="1", previs=False, track="1"):')
        .replace('    if stage.upper() in ("P3", "P4") and combat.upper() in COMBAT_FILES:', `    if stage.upper() == "P0":
        files.append("short-drama-director/references/track-routing.md")
    if track == "2" and stage.upper() in ("P0", "P1", "P4"):
        files.extend(["sd-overseas-engine/SKILL.md", "sd-overseas-engine/references/language-contract.md",
                      "sd-overseas-engine/references/north-american-english.md"])
    elif track == "3" and stage.upper() in ("P0", "P1", "P3", "P4", "P5"):
        files.extend(["sd-jieshuo-engine/SKILL.md", "sd-jieshuo-engine/references/narration-vo-script.md",
                      "sd-jieshuo-engine/references/history-visual-style.md", "sd-jieshuo-engine/references/explainer-formulas.md"])
    if model.lower() == "h3" and stage.upper() in ("P4", "P5"):
        files.append("short-drama-director/references/h3-adapter.md")
    if stage.upper() in ("P3", "P4") and combat.upper() in COMBAT_FILES:`)
        .replaceAll('source="1", previs=False, page=1):', 'source="1", previs=False, page=1, track="1"):')
        .replaceAll('resolve_files(stage, combat, model, source, previs)', 'resolve_files(stage, combat, model, source, previs, track)')
        .replace('build_slice(stage, combat, model, mode, lines, source, previs, page))', 'build_slice(stage, combat, model, mode, lines, source, previs, page, track))')
        .replace('f" --combat {combat} --model {model}', 'f" --track {track} --combat {combat} --model {model}')
        .replace('    ap.add_argument("--model", default="2.5", choices=["2.5", "2.0"])',
          '    ap.add_argument("--track", default="1", choices=["1", "2", "3", "4"])\n    ap.add_argument("--model", default="2.5", choices=["2.5", "2.0", "h3"])')
        .replaceAll('args.source, args.previs, args.page))', 'args.source, args.previs, args.page, args.track))');
      await writeFile(slicePath, slicer);
    }
    const compilerPath = join(root, 'short-drama-director/scripts/compile_feed.py');
    let compiler = await readFile(compilerPath, 'utf8');
    if (!compiler.includes('# greenroom-feed-timing-aspect')) {
      compiler = compiler.replace('def compile_project_to_feed(state):', `# greenroom-feed-timing-aspect
def feed_time(value):
    minutes, seconds = divmod(value, 60)
    return f"{int(minutes):02d}:" + ("0" if seconds < 10 else "") + f"{seconds:g}"


def compile_project_to_feed(state):`)
        .replace('    aspect = locks.get("aspect", "16:9")', '    aspect = locks.get("aspect", "16:9")\n    orientation = "竖屏" if aspect == "9:16" else "横屏"')
        .replace('st_t = int(sh.get("start", 0))', 'st_t = float(sh.get("start", 0))')
        .replace('ed_t = int(sh.get("end", st_t + 4))', 'ed_t = float(sh.get("end", st_t + 4))')
        .replace('t_str = f"{st_t // 60:02d}:{st_t % 60:02d}-{ed_t // 60:02d}:{ed_t % 60:02d}"', 't_str = f"{feed_time(st_t)}-{feed_time(ed_t)}"')
        .replace('f"【画幅风格】{aspect} 横屏，', 'f"【画幅风格】{aspect} {orientation}，');
      await writeFile(compilerPath, compiler);
    }
    const boardPath = join(root, 'short-drama-director/scripts/build_board_lite.py');
    let board = await readFile(boardPath, 'utf8');
    if (!board.includes('# greenroom-previs-not-video-segment')) {
      board = board.replace('    section = ""          # 当前 ## 章节', '    section = ""          # 当前 ## 章节\n    in_previs = False     # greenroom-previs-not-video-segment')
        .replace('            section = m_sec.group(1).strip()', `            section = m_sec.group(1).strip()
            if "预演" in section:
                in_previs = True
            elif not re.match(r"^段\\s*\\d", section):
                in_previs = False`)
        .replace('            if re.match(r"^【?投喂单元", section) or re.match(r"^段\\s*\\d", section):', '            if not in_previs and (re.match(r"^【?投喂单元", section) or re.match(r"^段\\s*\\d", section)):')
        .replace('            if zone_of(section) == "":', '            if in_previs or zone_of(section) == "":')
        .replace('            if re.match(r"^段\\s*\\d", sub_head) or re.match(r"^U\\d+\\b", sub_head) \\\n               or re.match(r"^第\\s*\\d+\\s*段", sub_head):', '            if not in_previs and (re.match(r"^段\\s*\\d", sub_head) or re.match(r"^U\\d+\\b", sub_head) \\\n               or re.match(r"^第\\s*\\d+\\s*段", sub_head)):');
      await writeFile(boardPath, board);
    }
    const validatorPath = join(root, 'short-drama-director/scripts/validate_prompt.py');
    let validator = await readFile(validatorPath, 'utf8');
    if (!validator.includes('# greenroom-c23-shot-boundaries')) {
      // Keep C23 strict, but only inspect the shot itself, not following STYLE/PERFORMANCE prose.
      validator = validator.replace('        elif cur is not None and ln.strip() and not ln.startswith("【"):', `        elif cur is not None and (ln.strip().startswith("【") or ln.strip().startswith("\x60\x60\x60") or ln.strip().startswith("#")):
            # greenroom-c23-shot-boundaries
            shot_blocks.append(cur)
            cur = None
        elif cur is not None and ln.strip():`);
      const start = validator.indexOf('C23_SHOT_LINE  = re.compile(');
      const end = validator.indexOf('C23_SHOT_LIGHT', start);
      validator = validator.slice(0, start) + validator.slice(start, end).replaceAll('\\d{1,2}:\\d{2}', '\\d{1,2}:\\d{2}(?:\\.\\d+)?') + validator.slice(end);
    }
    // V7.5 runs the whole segment quota inside the shot loop, duplicating C14 warnings.
    // Count each segment once while retaining the native per-shot safety checks.
    const quotaStart = validator.indexOf('        # VO/OS 是配额制调味料，三项篇幅卡口按段独立核算');
    const quotaEnd = validator.indexOf('    # C13 镜长雷同', quotaStart);
    if (quotaStart >= 0 && quotaEnd > quotaStart && !validator.includes('# greenroom-narration-track')) {
      const quota = validator.slice(quotaStart, quotaEnd).replace(/^ {4}/gm, '');
      validator = validator.slice(0, quotaStart) + quota + validator.slice(quotaEnd);
    }
    if (validator.includes('def cross_segment_alerts(') && !validator.includes('# greenroom-narration-track')) {
      // Restore the actual narration-track rules inside the native validator.
      validator = validator.replace('style_source=None, aspect=None, plugin="auto", state_data=None):',
        'style_source=None, aspect=None, plugin="auto", state_data=None, track="1"):')
        .replace('style_source=None, aspect=None, plugin="auto", state_data=None):',
          'style_source=None, aspect=None, plugin="auto", state_data=None, track="1"):')
        .replaceAll('state_data=state_data)', 'state_data=state_data, track=track)')
        .replace('value_flags = {"--model", "--combat"', 'value_flags = {"--model", "--track", "--combat"')
        .replace('    combat = opt("--combat", "auto")', `    track = opt("--track", "1")
    if track not in ("1", "2", "3", "4"):
        print("[-] --track 必须 1/2/3/4"); sys.exit(2)
    combat = opt("--combat", "auto")`)
        .replace('def _c23_on(text, mode="auto", style_source=None):', `# greenroom-narration-track
_NARR_CINE_VOCAB = tuple(sorted(("特写", "紧特写", "大特写", "极特写", "超特写", "近景", "中近景", "中景",
    "中全景", "全景", "远景", "大全景", "平视", "仰视", "俯视", "略仰", "略俯", "侧角", "正侧", "斜角",
    "顶拍", "过肩", "主观", "固定", "缓推", "慢推", "推", "拉", "摇", "移", "跟", "升降", "手持",
    "环绕", "变焦", "甩", "旋转", "横移", "垂直"), key=len, reverse=True))

def _narr_picture_length(pic):
    pic = SHOT_TAG_RE.sub("", TIME_RE.sub("", pic))
    for word in _NARR_CINE_VOCAB:
        pic = pic.replace(word, "")
    return len(re.findall(r"[\\u4e00-\\u9fa5]", pic))

def _c23_on(text, mode="auto", style_source=None):`)
        .replace('    # C14 画外声（OS/VO）——规程见 vo-os-weaving.md\n',
          '    # C14 画外声（OS/VO）——规程见 vo-os-weaving.md\n    vo_lines = []\n')
        .replace('        dlg_seg = line[dlg_idx:] if dlg_idx >= 0 else ""\n        # ① 声画分离红线',
          '        dlg_seg = line[dlg_idx:] if dlg_idx >= 0 else ""\n        if track == "3" and is_vo:\n            vo_lines.append((ln_i, pic_seg))\n        # ① 声画分离红线');
      const indent = (block) => block.split('\n').map((line) => line ? '    ' + line : line).join('\n');
      const start = validator.indexOf('    # VO/OS 是配额制调味料，三项篇幅卡口按段独立核算');
      const end = validator.indexOf('    # C13 镜长雷同', start);
      const narration = `    else:
        for ln_i, pic in vo_lines:
            if _narr_picture_length(pic) < 2:
                warns.append(f"C14n 第{ln_i}行 旁白镜无画面描述——解说类一句旁白配 1~2 个画面，画面须有实质描述")

`;
      validator = validator.slice(0, start) + '    if track != "3":\n' + indent(validator.slice(start, end)) + narration + validator.slice(end);
      for (const [first, last] of [
        ['    _c28_words, _c28_b, _c28_c = set(), [], []', '    # C29 资产状态偏离探测'],
        ['    _h29 = []', '    # C18m 段缝景别落差'],
      ]) {
        const from = validator.indexOf(first);
        const to = validator.indexOf(last, from);
        validator = validator.slice(0, from) + '    if track != "3":\n' + indent(validator.slice(from, to)) + validator.slice(to);
      }
    }
    if (validator.includes('def cross_segment_alerts(') && !validator.includes('# greenroom-h3-native-validation')) {
      const h3 = await readFile(join(integrationRoot, 'h3-rules.py'), 'utf8');
      validator = validator.replace('def _c23_on(text, mode="auto", style_source=None):',
        '# greenroom-h3-native-validation\n' + h3 + '\ndef _c23_on(text, mode="auto", style_source=None):')
        .replace('    if model not in ("2.5", "2.0"):\n        print("[-] --model 必须 2.5/2.0"); sys.exit(2)',
          '    if model not in ("2.5", "2.0", "h3"):\n        print("[-] --model 必须 2.5/2.0/h3"); sys.exit(2)')
        .replace('    if not _looks_like_feed(text):\n', `    if model == "h3":
        fields = "|".join(H3_SECTIONS + H3_FIELDS)
        if not re.search(r"^\\s*(?:" + fields + r")\\s*:", text, re.M):
            print("[!] 该文件不具备 H3 投喂稿字段；没有运行 H1–H12。")
            sys.exit(3)
        issues, warns, stats = validate_h3(text, opt("--mode", "new"))
        if "--json" in argv:
            print(json.dumps({"issues": issues, "warnings": warns, "stats": stats, "track": track,
                              "combat_checked": False, "c23_checked": False, "style_source": style_source},
                             ensure_ascii=False, indent=2))
        else:
            for warning in warns:
                print("[!] WARN: " + warning)
            for issue in issues:
                print("[-] FAIL: " + issue)
            print("[+] H3 原生 H1–H12 结构检查；不代表全项目交付验收")
        sys.exit(1 if issues else 0)
    if not _looks_like_feed(text):
`);
    }
    await writeFile(validatorPath, validator);
    const gatePath = join(root, 'sd-feed-engine/scripts/gate_check.py');
    let gate = await readFile(gatePath, 'utf8');
    // A failed native validator must not be reported as a passing gate.
    gate = gate.replace("return 0, 0, f'机检引擎调用失败（{exc}），本次只有投喂层闸门结果'", "return 1, 0, f'机检引擎调用失败（{exc}），本次只有投喂层闸门结果'");
    gate = gate.replace("return n_fail, n_warn, f'机检引擎已跑通", "return (max(1, n_fail) if proc.returncode else n_fail), n_warn, f'机检引擎已跑通");
    gate = gate.replace("return n_fail, n_warn, f'机检引擎异常退出（code={proc.returncode}）'", "return max(1, n_fail), n_warn, f'机检引擎异常退出（code={proc.returncode}）'");
    gate = gate.replace("return 0, 0, '机检引擎判定「非投喂稿件」，C 系判据未执行（稿件形态请核对）'", "return 1, 0, '机检引擎判定「非投喂稿件」，C 系判据未执行（稿件形态请核对）'");
    if (gate.includes('def run_syntax_engine(') && !gate.includes("ap.add_argument('--track'")) {
      gate = gate.replace("    ap.add_argument('--aspect', default=None,", "    ap.add_argument('--track', default='1', choices=['1', '2', '3', '4'])\n    ap.add_argument('--aspect', default=None,")
        .replace('a.path, a.model, a.aspect, a.syntax)', 'a.path, a.model, a.aspect, a.syntax, a.track)')
        .replace("def run_syntax_engine(path, model, aspect, mode='auto'):", "def run_syntax_engine(path, model, aspect, mode='auto', track='1'):")
        .replace("cmd = [sys.executable, engine, path, '--model', str(model)]", "cmd = [sys.executable, engine, path, '--model', str(model), '--track', str(track)]");
    }
    if (gate.includes('def run_syntax_engine(') && !gate.includes("ap.add_argument('--combat'")) {
      gate = gate.replace("    ap.add_argument('--track', default='1', choices=['1', '2', '3', '4'])", `    ap.add_argument('--track', default='1', choices=['1', '2', '3', '4'])
    ap.add_argument('--combat', default='auto', choices=['auto', 'on', 'off'])
    ap.add_argument('--plugin', default='auto', choices=['auto', 'real', 'combat', 'xuanhuan'])
    ap.add_argument('--state', default=None)
    ap.add_argument('--style-source', default=None)`)
        .replace('a.path, a.model, a.aspect, a.syntax, a.track)', 'a.path, a.model, a.aspect, a.syntax, a.track, a.combat, a.plugin, a.state, a.style_source)')
        .replace("def run_syntax_engine(path, model, aspect, mode='auto', track='1'):", "def run_syntax_engine(path, model, aspect, mode='auto', track='1', combat='auto', plugin='auto', state=None, style_source=None):")
        .replace("    if aspect:\n        cmd += ['--aspect', str(aspect)]", `    cmd += ['--combat', combat, '--plugin', plugin, '--delivery', 'feed-only']
    if state:
        cmd += ['--state', state]
    if style_source:
        cmd += ['--style-source', style_source]
    if aspect:
        cmd += ['--aspect', str(aspect)]`);
    }
    await writeFile(gatePath, gate);
    await patchSources(join(root, 'sd-script-engine'));
    await patchSources(join(root, 'sd-qc-engine'));
    for (const [name, expression] of [['style-lock-ladder.py', 'print(recommend(args.genre, top=args.top))'], ['style-lock-recommend.py', 'render(args.genre, top=args.top)']]) {
      const path = join(root, 'short-drama-director/scripts', name);
      let source = await readFile(path, 'utf8');
      const marker = '\nif __name__ == "__main__":';
      const base = name === 'style-lock-ladder.py' && source.includes('def recommend(text, top=4, base=None):');
      const baseArgument = base ? '    parser.add_argument("--base", choices=["真人", "2D", "3D", "水墨"])\n' : '';
      const call = base ? 'print(recommend(args.genre, top=args.top, base=parse_base(args.base)))' : expression;
      source = source.slice(0, source.indexOf(marker)) + `${marker}\n    import argparse\n    parser = argparse.ArgumentParser()\n    parser.add_argument("--genre", required=True)\n    parser.add_argument("--top", type=int, choices=range(1, 5), default=4)\n${baseArgument}    args = parser.parse_args()\n    ${call}\n`;
      await writeFile(path, source);
    }
  },
});
