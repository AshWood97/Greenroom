# ---- H 系列：MiniMax H3 格式支线（references/h3-adapter.md）----
H3_SECTIONS = ["subject_definitions", "summary", "retention_analysis",
               "detailed_description", "overall_soundscape", "non_diegetic_music"]
H3_FIELDS = ["integrated_multimodal_description", "overall_soundscape", "non_diegetic_music"]
H3_MARK_VIS = {"fully_preserved", "partially_preserved", "attribute_transfer", "weak_reference"}
H3_MARK_AUD = {"fully_copy", "partially_copy", "reference", "weak_reference"}
H3_LABEL_RE = re.compile(r"<(Subject|Picture|Video|Audio)\s+(\d+)>")
H3_SHOT_RE = re.compile(r"\[Shot\s+(\d+)\]")
H3_CUT_RE = re.compile(r"\[Shot\s+(\d+)\][^\n]{0,14}?(?:At|在)\s*(\d{1,2}):(\d{2})\.(\d{3})")
H3_SEVEN_LEAK = ["【画幅风格】", "【场景资产】", "【核心人物】", "【站位声明】", "【时间轴分镜】",
                 "【音效】", "【强制禁止项】", "【接续状态】"]
# H8 内部术语（打击感语法词——H3 无 Hit-Stop 语法，须转译为可见物理描述）
#   + 转场术语（2026-10-13 体检修复 A1：同 C12 口径，J-cut/L-cut/Whip Pan/Match Cut/Sound Bridge
#     禁裸写进 H3 正文；「甩镜/抽帧/音桥」按 Seedance 侧同一收窄口径不收——运镜词/风格参数/法定标注）
H3_JARGON = ["顿挫", "阻尼", "弹开", "微停顿",
             "J-cut", "L-cut", "Whip Pan", "Match Cut", "Sound Bridge"]
H3_WORKFLOW = ["末态继承", "拼接节点", "换机位", "同机位硬接"]
H3_MIN_DUR, H3_MAX_DUR = 4, 15
H3_PIC_MAX = 9
H3_VO_EVID = re.compile(r"闭合|闭口|紧闭|lips\s+(?:remain|stay)\s+(?:completely\s+)?closed")
# H9 画外声官方固定短语（base-en §4.4；2026-10-02 官方复核新增）
H3_VO_PHRASE = re.compile(r"says\s+in\s+an\s+off[- ]screen\s+voiceover", re.I)
# H2 切镜动词官方绑定短语（base-en §4.2；中文"镜头切至"不被绑定，会被做成叠化融脸）
H3_CUT_VERB = re.compile(r"the\s+(?:camera|shot|image)\s+(?:cuts?|transitions?|changes?|switches?)\s+to", re.I)
H3_BAD_CUT_VERB = re.compile(r"镜头切至|cross[- ]?dissolve|淡入淡出|叠化|\bfade\b|\bwipe\b", re.I)
# H4 正文语言（2026-10-02：六段正文一律英文；此处只用于"检测 <d> 与双引号之外的中文"）
H3_CJK = re.compile(r"[\u4e00-\u9fff]")
H3_TONE_HINT = re.compile(r"音色|语气|语速|声线|嗓音|男声|女声|童声|气息|平直|平稳|低沉|沙哑|清亮|清冷|温润|明亮|"
                          r"浑厚|尖锐|急促|缓慢|克制|冷淡|温和|冰冷|慵懒|疲惫|哽咽|颤|喘|轻声|低声|高声|低语|耳语|呢喃|"
                          r"压着|斩钉截铁|喊|吼|"
                          # 英文声学词（2026-10-02 官方复核：H3 正文英文口径，声学提示词表同步补英文）
                          r"\bpitch\b|\btimbre\b|\baccent\b|speaking rate|\bmonotone\b|\bhusky\b|\bhoarse\b|"
                          r"\bnasal\b|\bbreathy\b|low[- ]pitched|high[- ]pitched|soft[- ]spoken|\bgravelly\b|\bvelvet(?:y)?\b")
# H8 否定式（对应 C19/法则 22：模型对否定不敏感、对词根敏感；H3 正文只写"有什么"）
H3_NEG_PAT = re.compile(r"不要出现|不要有|禁止出现|不能出现|不得出现|"
                        r"没有[\u4e00-\u9fa5]{0,4}(?:人物|角色|家具|背景|文字|字幕|水印)")
# H12 首镜锚定 / 单主体（对应 C18a / C20a / C20b）
H3_PARALLEL_PAT = re.compile(r"同框|同在画面|一同入画|同处一室")
H3_DEIXIS_PAT = re.compile(r"(这只|那只|这个|那个|这双|那副)(手|脸|眼睛|脚|背影|身体)")


def _h3_order(text):
    """返回出现过的六段字段名，按文件顺序。"""
    pat = re.compile(r"^\s*(" + "|".join(H3_SECTIONS) + r")\s*[:：]")
    out = []
    for line in text.splitlines():
        m = pat.match(line)
        if m and m.group(1) not in out:
            out.append(m.group(1))
    return out


def _h3_sections(text):
    """按行首字段名+冒号切分，返回 {字段: 内容}。"""
    pat = re.compile(r"^\s*(" + "|".join(H3_SECTIONS) + r")\s*[:：]\s*(.*)$")
    out, cur = {}, None
    for line in text.splitlines():
        m = pat.match(line)
        if m:
            cur = m.group(1)
            out[cur] = [m.group(2)]
        elif cur:
            out[cur].append(line)
    return {k: "\n".join(v).strip() for k, v in out.items()}


def validate_h3(text, mode="new"):
    """MiniMax H3 格式支线检查（H1~H12）。规程见 references/h3-adapter.md。"""
    issues, warns = [], []
    sec = _h3_sections(text)
    order = _h3_order(text)
    is_ref = "subject_definitions" in sec

    # H1 字段集
    if is_ref:
        missing = [s for s in H3_SECTIONS if s not in sec]
        if missing:
            issues.append(f"H1 Ref2VA 缺段 {missing}（六段式：subject_definitions/summary/retention_analysis/"
                          "detailed_description/overall_soundscape/non_diegetic_music，顺序不可调换）")
        elif order != H3_SECTIONS:
            issues.append(f"H1 Ref2VA 段序错误：实际 {order}")
    else:
        missing = [f for f in H3_FIELDS if f not in text]
        if missing:
            issues.append(f"H1 基础模式缺字段 {missing}（应为 integrated_multimodal_description / "
                          "overall_soundscape / non_diegetic_music）")

    # H2 镜号与切点（只看正文分镜段：Ref2VA 取 detailed_description，基础模式取全文）
    body = sec.get("detailed_description", "") if is_ref else text
    if re.search(r"\[Shot\s*1\][^\n]{0,14}?(?:At|在)\s*\d{1,2}:\d{2}", body):
        issues.append("H2 [Shot 1] 不得带时间戳（首镜无切点，切点从 [Shot 2] 起）")
    nums = [int(n) for n in H3_SHOT_RE.findall(body)]
    uniq = list(dict.fromkeys(nums))
    cuts = [(int(m[0]), int(m[1]) * 60 + int(m[2]) + int(m[3]) / 1000.0) for m in H3_CUT_RE.findall(body)]
    if uniq:
        if uniq != sorted(uniq):
            issues.append(f"H2 [Shot N] 镜号未递增：{uniq}（首现顺序）")
        want = [n for n in sorted(set(nums)) if n >= 2]
        got = [n for n, _ in cuts]
        miss_cut = [n for n in want if n not in got]
        if miss_cut:
            issues.append(f"H2 [Shot {miss_cut}] 缺切点时间码（MM:SS.mmm）")
    for (n1, t1), (n2, t2) in zip(cuts, cuts[1:]):
        if t2 <= t1:
            issues.append(f"H2 切点未严格递增：[Shot {n1}] {t1}s -> [Shot {n2}] {t2}s")
    if cuts and max(t for _, t in cuts) > H3_MAX_DUR + 0.001:
        issues.append(f"H3 最后切点 {max(t for _, t in cuts)}s > {H3_MAX_DUR}s（H3 单段硬上限 15s；"
                      "Seedance 2.5 的 15~30s 段必须再拆一刀）")

    # H3 时长声明
    decl = None
    m = re.search(r'"?(?:duration_seconds|duration)"?\s*[:=]\s*(\d+(?:\.\d+)?)', text)
    if m:
        decl = float(m.group(1))
    else:
        m2 = re.search(r"时长\s*[:：]\s*(\d+(?:\.\d+)?)\s*(?:s|秒|seconds)", text)
        if m2:
            decl = float(m2.group(1))
    if decl is not None:
        if not (H3_MIN_DUR - 0.01 <= decl <= H3_MAX_DUR + 0.01):
            issues.append(f"H3 声明时长 {decl}s 越界（H3 硬区间 {H3_MIN_DUR}–{H3_MAX_DUR}s）")
    else:
        warns.append(f"H3 未标注目标时长——H3 硬区间 {H3_MIN_DUR}–{H3_MAX_DUR}s，"
                     "建议在稿头或载荷标注 duration_seconds 以便校验")

    # H4 语言标签 + 正文语言（2026-10-02 官方复核：六段正文一律英文）
    bad_d = re.findall(r"<d>(?!\s*\[)", text)
    if bad_d:
        issues.append(f"H4 <d> 缺语言标签 {len(bad_d)} 处——应为 <d>[Chinese] 原文</d>（语言标签保留原语言；"
                      "正文语言见下，2026-10-02 起一律英文）")
    _no_d = re.sub(r"<d>.*?</d>", "", text, flags=re.S)          # 台词/歌词保原语言，先摘除
    _no_d = re.sub(r"[\"“][^\"”\n]{0,60}[\"”]", "", _no_d)       # 双引号内画内文字保原语言，摘除
    if is_ref and order:                                          # 仅审 H3 原生格式稿（七段式旧稿不套用）
        if H3_CJK.search(_no_d):
            warns.append("H4 正文出现中文——官方 base-en/ref-en 明文「Write all six rewrite sections in English」，"
                         "**六段正文一律英文**；只有 <d> 内台词/歌词与双引号内画内文字保留原语言"
                         "（h3-adapter.md 2026-10-02 官方复核修订；旧「跟随内容主语言」口径已废止）")
    if H3_BAD_CUT_VERB.search(text) and not H3_CUT_VERB.search(text):
        warns.append("H2 切镜动词未用官方绑定短语——官方 base-en §4.2：the camera cuts to / the shot cuts to / "
                     "the shot transitions to / the shot changes to / the shot switches to；"
                     "中文「镜头切至」与 cross-dissolve/fade/wipe 会被做成叠化融脸（仅用户明确要求时才用过渡）")

    # H5 参考标签（used 从“定义段之外”统计：标签在其定义行里出现不算被引用）
    if is_ref:
        defined = {(k, int(n)) for k, n in H3_LABEL_RE.findall(sec.get("subject_definitions", ""))}
        rest = text.replace(sec.get("subject_definitions", ""), "")
        used = {(k, int(n)) for k, n in H3_LABEL_RE.findall(rest)}
        undef = sorted(used - defined)
        if undef:
            issues.append(f"H5 未定义标签 {[f'<{k} {n}>' for k, n in undef]}——须先在 subject_definitions 定义后再引用")
        sum_new = {(k, int(n)) for k, n in H3_LABEL_RE.findall(sec.get("summary", ""))} - defined
        if sum_new:
            issues.append(f"H5 summary 引入了新标签 {sorted(sum_new)}（summary 只用已定义标签）")
        if len(defined) > H3_PIC_MAX:
            warns.append(f"H5 subject_definitions 定义 {len(defined)} 项 > H3 Ref2VA 素材上限提示（图 {H3_PIC_MAX} 张）——"
                         "按 h3-adapter.md §四「9 张取材策略」裁剪或合并")
        # 只查 Subject（可复用内容单元）：Picture/Video/Audio 允许只作为来源引用出现在定义行内
        unused = sorted({(k, n) for (k, n) in defined - used if k == "Subject"})
        if unused:
            warns.append(f"H5 定义了却全文未引用 {[f'<{k} {n}>' for k, n in unused]}——白占 9 张额度，"
                         "或人物凭空消失（摆位必入画 · 法则 20）；删掉或补进对应镜头")

    # H6 保留度标记
    ra = sec.get("retention_analysis", "")
    if is_ref and ra:
        for mm in re.finditer(r"[:：]\s*([a-z_]{3,})\s*[-–—]", ra):
            if mm.group(1) not in (H3_MARK_VIS | H3_MARK_AUD):
                issues.append(f"H6 retention_analysis 非法保留度标记「{mm.group(1)}」——合法值：画面 "
                              "fully_preserved/partially_preserved/attribute_transfer/weak_reference；音频 "
                              "fully_copy/partially_copy/reference/weak_reference")
        if re.search(r"[（(]\s*S\d", ra):
            issues.append("H6 retention_analysis 不得写 (Sx)——说话人编号只出现在 detailed_description")

    # H7 说话人编号顺序（兼容半角/全角括号）
    dd = sec.get("detailed_description", "") or text
    seen = []
    for m in re.finditer(r"[（(]\s*(S\d+(?:\s*[,，]\s*S\d+)*)\s*[)）]", dd):
        for sid in re.split(r"[,，]", m.group(1)):
            sid = sid.strip()
            if sid and sid not in seen:
                seen.append(sid)
    if seen and seen != [f"S{i + 1}" for i in range(len(seen))]:
        issues.append(f"H7 (Sx) 未按首现顺序编号：实际首现序 {seen}（应从 (S1) 起递增；未发声角色不给 ID）")

    # H8 泄漏检查
    leak = [s for s in H3_SEVEN_LEAK if s in text]
    if leak:
        issues.append(f"H8 七段式栏名泄漏进 H3 正文 {leak}——H3 支线用原生字段（三字段/六段式），栏名不进正文")
    anchors = sorted(set(re.findall(r"@(?:CHR|SCN|PRP|AUD)-[\w\-]+", text)))
    if anchors:
        issues.append(f"H8 `@` 资产锚点泄漏 {anchors}——H3 用 <Subject N>/<Picture N>/<Video N>/<Audio N> 标签")
    wf = sorted({w for w in H3_WORKFLOW if w in text})
    if wf:
        warns.append(f"H8 工作流规则词混入 {wf}——规则由执行者应用，H3 正文只写画面（同 C12 口径）")
    _h3_low = text.lower()
    jg = sorted({w for w in H3_JARGON if w.lower() in _h3_low})
    if jg:
        warns.append(f"H8 内部术语/转场术语混入 {jg}——H3 正文只写可见画面：打击感转译为可见物理描述"
                     "（接触凝住一拍 + 反作用力），转场术语转译为画面怎么接（同 C12 口径，术语只在分镜层标注）")
    neg = sorted({m.group(0) for m in H3_NEG_PAT.finditer(text)})
    if neg:
        warns.append(f"H8 正文出现否定式 {neg}——模型对否定不敏感、对词根敏感（C19/法则 22）："
                     "删掉否定式，改为正向表述；负面清单不进 H3 正文")

    # H9 画外声
    if re.search(r"画外音|内心独白|旁白|voiceover|\bOS\b|\bVO\b", text):
        if not H3_VO_EVID.search(text):
            issues.append("H9 画外声缺闭口证据——官方要求紧跟「lips remain completely closed」"
                          "（等同 vo-os-weaving 声画分离红线）")
        if not H3_VO_PHRASE.search(text):
            warns.append("H9 画外声未用官方固定短语「says in an off-screen voiceover」——官方 base-en §4.4 固定公式："
                         "`<Subject N> (Sx) says in an off-screen voiceover: <d>[Language] …</d> "
                         "while his/her lips remain completely closed.`；中文自创措辞压不住口型（2026-10-02 实测）")
        if re.search(r"\{[^}]*\}", text):
            issues.append("H9 画外声禁用 {} 台词字符（{} 是锁口型对白通道，画外声走官方公式英文标注）")

    # H10 声音分层
    for f in ("overall_soundscape", "non_diegetic_music"):
        if "<d>" in sec.get(f, ""):
            issues.append(f"H10 {f} 段不得包含对白 <d>——对白只进 detailed_description（基础模式为 integrated_multimodal_description）")
    if re.search(r"台词", sec.get("overall_soundscape", "")):
        warns.append("H10 overall_soundscape 出现「台词」字样——对白不进声音层汇总")
    nd = sec.get("non_diegetic_music", "")
    for m in re.finditer(r"<d>(.*?)</d>", text, re.S):
        body_d = m.group(1).split("]", 1)[-1].strip()
        if body_d and body_d in nd:
            issues.append("H10 non_diegetic_music 复述了台词内容——BGM 段只写配器/速度/节奏/动态，不重复对白")
            break

    # H11 语气位继承（WARN · 对应法则 19 / 官方"发言人首次出现须给发声特征"）
    first_pos = {}
    for m in re.finditer(r"[（(]\s*(S\d+)\s*[)）]", dd):
        sid = m.group(1)
        if sid not in first_pos:
            first_pos[sid] = m.start()
    for sid, pos in first_pos.items():
        if not H3_TONE_HINT.search(dd[max(0, pos - 120):pos + 120]):
            warns.append(f"H11 {sid} 首次出现处缺语气/音色/语速描述——H3 要求发言人首次出场给出发声特征"
                         "（音高/音质/语速/口音），丢了语气等于退掉法则 19（对白三要素之三）")

    # H12 首镜锚定 / 单主体（对应 C18a / C20a / C20b）
    shot1 = ""
    ms = re.search(r"\[Shot\s*1\]([^\n]*(?:\n(?!\s*\[Shot)[^\n]*)*)", body)
    if ms:
        shot1 = ms.group(1)
    if shot1:
        # 首镜锚 = 具名主体（只认 <Subject N>；<Picture/Video/Audio N> 不是主体锚）
        if not re.search(r"<Subject\s+\d+>", shot1):
            warns.append("H12a 首镜无具名主体锚——[Shot 1] 未引用任何 <Subject N>（对应 C18a 首镜人物锚）："
                         "空镜开场须写明「空镜：…」且每段至多 1 镜；否则给首镜一个具名主体（人名或注明归属的部位）")
        par = H3_PARALLEL_PAT.search(shot1)
        if par:
            warns.append(f"H12b 首镜出现并列主体/同框句式「{par.group(0)}」——模型会读成画面里有两个主体"
                         "（C20a：同一主体的手与脸被渲染成两张脸）；锚定句只由**一个具名主体**统摄")
    dei = H3_DEIXIS_PAT.search(body)
    if dei:
        warns.append(f"H12c 悬空指示代词「{dei.group(0)}」——指代词没有先行词，模型自行补一个主体（C20b）："
                     "改写为「她的/其+部位」")

    stats = {"duration_s": decl or (max((t for _, t in cuts), default=0)),
             "shots": len(nums), "chars": len(text)}
    return issues, warns, stats
