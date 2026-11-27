const formats = ["image/png", "image/jpeg", "image/webp", "image/gif", "image/avif", "image/bmp", "image/x-ms-bmp"];
export const profileImageAccept = formats.join(",");

export function isProfileImage(value) {
  return typeof value === "string" && value.length <= 256 * 1024 && value.startsWith("data:image/webp;base64,UklGR");
}

export async function prepareProfileImage(file, t) {
  if (!file?.size || (file.type && !formats.includes(file.type))) {
    throw new Error(t("请选择 PNG、JPEG、WebP、GIF、AVIF 或 BMP 图片。", "Choose a PNG, JPEG, WebP, GIF, AVIF, or BMP image."));
  }
  if (file.size > 20 * 1024 * 1024) {
    throw new Error(t("请选择 20 MB 以内的图片。", "Choose an image smaller than 20 MB."));
  }

  let bitmap;
  try {
    bitmap = await createImageBitmap(file);
    const size = Math.min(bitmap.width, bitmap.height);
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 256;
    const context = canvas.getContext("2d");
    context.imageSmoothingQuality = "high";
    context.drawImage(bitmap, (bitmap.width - size) / 2, (bitmap.height - size) / 2, size, size, 0, 0, 256, 256);
    const avatar = canvas.toDataURL("image/webp", 0.86);
    if (isProfileImage(avatar)) return avatar;
  } catch {
    // The file may have a supported MIME type but contain undecodable image data.
  } finally {
    bitmap?.close();
  }
  throw new Error(t("无法读取这张图片，请选择其他图片。", "This image could not be read. Choose another image."));
}
