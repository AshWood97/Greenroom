/**
 * 对成员展示名称进行隐私脱敏（中间“*”号处理）：
 * - 空或单字符：直接返回
 * - 2 字（如“李飞”、“崔志”）：保留首字，末位脱敏为“*”（如“李*”、“崔*”）
 * - 3 字（如“徐子寒”、“顾俊玮”）：保留首尾，中间脱敏为“*”（如“徐*寒”、“顾*玮”）
 * - 4 字及以上（如“Michael”、“Kitty”、“vivienneZ”）：保留首尾字符，中间字符替换为等长星号（如“M*****l”、“K***y”、“v*******Z”）
 */
export function maskDisplayName(name: string): string {
  if (!name || name.length <= 1) {
    return name;
  }
  if (name.length === 2) {
    return `${name[0]}*`;
  }
  return `${name[0]}${'*'.repeat(name.length - 2)}${name[name.length - 1]}`;
}
