import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { createCanvas, loadImage } from "@napi-rs/canvas";

const project = fileURLToPath(new URL("../", import.meta.url));
const publicDirectory = resolve(project, "public");
const brandDirectory = resolve(publicDirectory, "brand");
const master = resolve(brandDirectory, "smartbill-icon-1200.png");
const source = process.argv[2] ? resolve(process.argv[2]) : master;
const masterBytes = await readFile(source);
const original = await loadImage(masterBytes);
assert.equal(original.width, 1200, "The approved master must be 1200px wide.");
assert.equal(original.height, 1200, "The approved master must be 1200px tall.");
assert.ok(
  masterBytes.length < 1_000_000,
  "The listing icon must be under 1 MB.",
);
await mkdir(brandDirectory, { recursive: true });
if (source !== master) await writeFile(master, masterBytes);

const sizes = [16, 32, 48, 64, 128, 180, 256, 512];
const images = new Map();
for (const size of sizes) {
  const canvas = createCanvas(size, size);
  const context = canvas.getContext("2d");
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.drawImage(original, 0, 0, size, size);
  const png = canvas.toBuffer("image/png");
  images.set(size, png);
  await writeFile(resolve(brandDirectory, `smartbill-icon-${size}.png`), png);
  console.log(`smartbill-icon-${size}.png: ${png.length} bytes`);
}

// ICO directory entries embed PNG images at the native browser favicon sizes.
const faviconSizes = [16, 32, 48];
const directory = Buffer.alloc(6 + faviconSizes.length * 16);
directory.writeUInt16LE(1, 2);
directory.writeUInt16LE(faviconSizes.length, 4);
let offset = directory.length;
for (const [index, size] of faviconSizes.entries()) {
  const png = images.get(size);
  const entry = 6 + index * 16;
  directory.writeUInt8(size, entry);
  directory.writeUInt8(size, entry + 1);
  directory.writeUInt16LE(1, entry + 4);
  directory.writeUInt16LE(32, entry + 6);
  directory.writeUInt32LE(png.length, entry + 8);
  directory.writeUInt32LE(offset, entry + 12);
  offset += png.length;
}
const ico = Buffer.concat([
  directory,
  ...faviconSizes.map((size) => images.get(size)),
]);
await writeFile(resolve(publicDirectory, "favicon.ico"), ico);
await writeFile(
  resolve(publicDirectory, "apple-touch-icon.png"),
  images.get(180),
);
console.log(
  `favicon.ico: ${ico.length} bytes; apple-touch-icon.png: 180 x 180`,
);
