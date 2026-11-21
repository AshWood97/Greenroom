import sharp from 'sharp';

// Only split an existing grid. This does not generate the native quad-grid prompt or new model images.
// Matches director/split-scenes.tsx and sclass/sclass-scenes.tsx: floor(width/2), floor(height/2), row-major.
export async function splitQuadImage(bytes) {
  if (!(bytes instanceof Uint8Array) || !bytes.length) throw new Error('四宫格图片内容为空');
  const input = Buffer.from(bytes);
  const metadata = await sharp(input).metadata();
  if ((metadata.pages || 1) !== 1) throw new Error('四宫格切分仅支持单帧图片');
  // Browser Image uses the displayed EXIF orientation; rotate() normalizes it before applying native coordinates.
  const { data, info } = await sharp(input).rotate().png().toBuffer({ resolveWithObject: true });
  const width = Math.floor(info.width / 2);
  const height = Math.floor(info.height / 2);
  if (width < 1 || height < 1) throw new Error('四宫格图片宽高至少为2像素');
  const positions = ['top-left', 'top-right', 'bottom-left', 'bottom-right'];
  const tiles = [];
  for (let index = 0; index < 4; index++) {
    const tile = await sharp(data).extract({ left: (index % 2) * width,
      top: Math.floor(index / 2) * height, width, height }).png().toBuffer();
    tiles.push({ index, position: positions[index], width, height, bytes: tile });
  }
  return { width: info.width, height: info.height, tiles };
}
