// Public upstream repository, pinned revision and primary license.
const upstream = [
  ['t8','T8 画布','T8mars/T8-penguin-canvas','1d7061c0e6d2be92797b9e3f2ff0d485915e7','MIT','canvas'],
  ['huobao','火宝短剧','chatfire-AI/huobao-drama','b48e6b2312166e25b1ff141832d2e82e5d63c142','CC-BY-NC-SA-4.0','restricted'],
  ['moneyprinter','MoneyPrinterTurbo','harry0703/MoneyPrinterTurbo','c235354804104665b58679223847f78c2b5e27d4','MIT','external'],
  ['toonflow','Toonflow','HBAI-Ltd/Toonflow-app','6086cdffceb704a632eca143dd16cd461a78cdac','MIT','external'],
  ['open-ai-canvas','影策','ddcat-ai/open-ai-canvas','3ce013ec15a1a6065654986fd7f9433bf8d10b8c','MIT','external'],
  ['moyin','魔因漫创','MemeCalculate/moyin-creator','7e5c5655de94d49885e13c369f0a71212893a0aa','AGPL-3.0-or-later','separate'],
  ['arcreel','ArcReel','ArcReel/ArcReel','afdb2091af79c154f87c3a1683bfb5d2ddd75493','AGPL-3.0-only','separate'],
  ['localminidrama','LocalMiniDrama','xuanyustudio/LocalMiniDrama','3fbcda9713ca545979dff9e75d21bed53694188f','MIT','external'],
  ['aid-studio','AID Studio','shijue-aid/aid-studio','804a775dd03cfb144a8218b3a6fdea876c7e8066','MIT','external'],
  ['kineo','Kineo','Agions/kineo','45572564546fe885bf5b76adccccc9b073f7c5af','MIT','external'],
  ['openslop','OpenSlop','openslop/openslop','8848790b15730b63f601e8795790880379660c5f','Apache-2.0','external'],
  ['vimax','ViMax','HKUDS/ViMax','fd4b72e7731be6e5f88486206d25ea59849b0285','MIT','external'],
  ['openmontage','OpenMontage','OpenMontageInc/OpenMontage','fecb9a1e3cc23ef84de30b272059457a427f16f8','AGPL-3.0-only','separate'],
  ['drama-skills','Drama Skills','zenstory-ai/drama-skills','3d813c30871b4db5f2387d83bdc3a49db8ce7b2b','MIT','skills'],
  ['shuohao-skills','Shuohao Skills','eternityspring/shuohao-skills','8af10e0ea1a550e4575666884f4deef780bf38ff','Apache-2.0','skills'],
  ['lemo-opuscar','Lemo Opuscar','lemomo-ai/lemo-opuscar','143f387ad774525dc9abc0ff05fb5f4bfbaa5f02','MIT · 素材另有许可','skills'],
  ['manju-laoli-skill','漫剧老李','lixiaoxiao9888-create/manju-laoli-skill','ffa717b83f21fecb968d7697690196486a65332c','MIT','skills'],
  ['awesome-short-drama-skills','短剧 Skill 查找','UnderleveledBuilder/awesome-short-drama-skills','9a1f686460c0a03cb0df40c3d2e55739568911dc','CC0-1.0','skills'],
  ['director-skills','导演 Skills','kangarooking/director-skills','301e6e72199f28b8ea82cd48ff06ab9ae49d0ee5','MIT','skills'],
  ['take-one','首映创作室','talsiach/take-one','43fd27b8878241deb50a5884a154b173272b858f','MIT · 依赖另有许可','skills'],
  ['manjuforge','ManjuForge','mengxiujie/ManjuForge','e6a42b29dbc19cdd315fa54ebed38c43247d74eb','MIT-0','skills'],
  ['hypit','Hypit','hypit-ai/hypit','25454bed40bbb09eaf675e217ed9901fa8ef4f2a','自定义许可','restricted'],
];

export const plugins = [
  { id: 'dsh', name: 'DeepSeek Harness', upstream: 'https://github.com/deepseek-ai/deepseek-harness',
    revision: '9c2670d3bce5275e0d1610272958121af87787bb', license: 'MIT', mode: 'native' },
  ...upstream.map(([id, name, repo, revision, license, mode]) => ({
    id, name, upstream: 'https://github.com/' + repo, revision, license, mode,
  })),
];
