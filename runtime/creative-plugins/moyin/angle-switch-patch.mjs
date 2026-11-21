import { readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
export function patchManagedAngles(root) {
  copyFileSync(new URL('./angle-switch.ts', import.meta.url), join(root, 'src/lib/ai/greenroom-angle-switch.ts'));
  for (const file of ['director/shot-grid-view.tsx', 'director/shot-properties-panel.tsx', 'director/split-scenes.tsx', 'sclass/sclass-scenes.tsx']) {
    const filename = join(root, 'src/components/panels', file);
    let source = readFileSync(filename, 'utf8').replaceAll('\r\n', '\n');
    const before = 'import { generateAngleSwitch } from "@/lib/ai/runninghub-client";';
    if (!source.includes(before)) throw new Error('视角导入位置已变化：' + file);
    source = source.replace(before, 'import { generateAngleSwitch } from "@/lib/ai/greenroom-angle-switch";');
    const block = /    \/\/ Get RunningHub (?:API key|provider config)\n[\s\S]*?      return;\n    \}/;
    if (!block.test(source)) throw new Error('视角前置位置已变化：' + file);
    source = source.replace(block, `    // A managed image model is required; reference-image capability is checked by the administrator service.
    if (!(globalThis as any).greenroomCatalog?.models?.image?.length) {
      toast.error("管理员尚未启用图片模型；参考图能力由托管服务判定");
      setAngleSwitchOpen(false);
      return;
    }`);
    source = source.replace(/        apiKey(?:: runninghubKey)?,\n        baseUrl(?:: runninghubBaseUrl)?,\n        appId(?:: runninghubAppId)?,\n/, '');
    writeFileSync(filename, source);
  }
  const dialog = join(root, 'src/components/angle-switch/AngleSwitchDialog.tsx');
  let source = readFileSync(dialog, 'utf8').replaceAll('\r\n', '\n');
  const title = '视角切换 - {frameType === "start" ? "首帧" : "尾帧"}';
  if (!source.includes(title)) throw new Error('视角标题位置已变化');
  source = source.replace(title, '托管参考图视角切换 - {frameType === "start" ? "首帧" : "尾帧"}');
  source = source.replace('</DialogHeader>', '</DialogHeader>\n        <p className="text-xs text-muted-foreground">使用管理员图片模型重新生成，非 RunningHub App。参考图能力由托管服务判定，视角效果未保证；点击生成可能产生费用。</p>');
  writeFileSync(dialog, source);
}
