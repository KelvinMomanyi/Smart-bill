const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { createCanvas, loadImage } = require("@napi-rs/canvas");

async function main() {
  const source = process.argv[2];
  const outputStem = process.argv[3] || "smartbill-app-icon-1200";
  assert.ok(source, "Provide the generated source PNG path.");
  assert.match(outputStem, /^[a-z0-9-]+$/, "Use a simple output filename.");
  const original = await loadImage(source);
  assert.equal(original.width, original.height, "Source must be square.");

  const canvas = createCanvas(1200, 1200);
  const context = canvas.getContext("2d");
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.drawImage(original, 0, 0, 1200, 1200);

  const pixels = context.getImageData(0, 0, 1200, 1200).data;
  for (let offset = 3; offset < pixels.length; offset += 4) {
    assert.equal(pixels[offset], 255, "Icon must be fully opaque.");
  }

  const variants = [
    ["png", canvas.toBuffer("image/png")],
    ["jpg", canvas.toBuffer("image/jpeg", 95)],
  ];
  for (const [extension, buffer] of variants) {
    assert.ok(buffer.length < 1_000_000, `${extension} must be under 1 MB.`);
    const output = path.join(__dirname, `${outputStem}.${extension}`);
    await fs.writeFile(output, buffer, { flag: "wx" });
    const exported = await loadImage(output);
    assert.equal(exported.width, 1200);
    assert.equal(exported.height, 1200);
    console.log(JSON.stringify({
      path: output,
      width: exported.width,
      height: exported.height,
      bytes: (await fs.stat(output)).size,
      opaque: true,
    }));
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
