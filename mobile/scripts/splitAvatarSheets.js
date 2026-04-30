#!/usr/bin/env node

const fs = require("fs/promises");
const path = require("path");
const sharp = require("sharp");

const AVATAR_DIR = path.resolve(__dirname, "../assets/images/avatar");
const PREPARED_DIR = path.join(AVATAR_DIR, "prepared");
const PARTS_DIR = path.join(AVATAR_DIR, "parts");

const FOLDER_CONFIGS = [
  {
    folder: "hair",
    prefix: "hair",
    sources: [{ file: "hair_sheet.png", count: 20, cols: 5, rows: 4 }],
  },
  {
    folder: "eyes",
    prefix: "eye_shape",
    // 20 secenek: 10 sekil + 10 renk
    sources: [
      { file: "eye_shapes_sheet.png", count: 10, cols: 5, rows: 2 },
      { file: "eye_colors_sheet.png", count: 10, cols: 5, rows: 2 },
    ],
  },
  {
    folder: "face",
    prefix: "face",
    sources: [{ file: "face_types_sheet.png", count: 20, cols: 5, rows: 4 }],
  },
  {
    folder: "top",
    prefix: "top",
    sources: [{ file: "top_clothes_sheet.png", count: 20, cols: 5, rows: 4 }],
  },
  {
    folder: "bottom",
    prefix: "bottom",
    sources: [{ file: "bottom_clothes_sheet.png", count: 20, cols: 5, rows: 4 }],
  },
  {
    folder: "shoes",
    prefix: "shoes",
    sources: [{ file: "shoes_sheet.png", count: 20, cols: 5, rows: 4 }],
  },
  {
    folder: "accessories",
    prefix: "accessory",
    sources: [{ file: "accessories_sheet.png", count: 20, cols: 5, rows: 4 }],
  },
];

async function ensureDirectories() {
  await fs.mkdir(PARTS_DIR, { recursive: true });
  await Promise.all(
    FOLDER_CONFIGS.map((config) => fs.mkdir(path.join(PARTS_DIR, config.folder), { recursive: true })),
  );
}

async function splitSourceIntoParts(sourcePath, count, cols, rows) {
  const metadata = await sharp(sourcePath).metadata();
  const width = metadata.width || 0;
  const height = metadata.height || 0;

  if (!width || !height) {
    throw new Error(`Gorsel boyutu okunamadi: ${sourcePath}`);
  }

  const cellWidth = Math.floor(width / cols);
  const cellHeight = Math.floor(height / rows);
  const crops = [];

  for (let i = 0; i < count; i += 1) {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const left = col * cellWidth;
    const top = row * cellHeight;

    const extractWidth = col === cols - 1 ? width - left : cellWidth;
    const extractHeight = row === rows - 1 ? height - top : cellHeight;

    crops.push({ left, top, width: extractWidth, height: extractHeight });
  }

  return crops;
}

async function main() {
  await ensureDirectories();
  const summary = {};
  let total = 0;

  for (const config of FOLDER_CONFIGS) {
    const outputDir = path.join(PARTS_DIR, config.folder);
    let outputIndex = 1;
    let producedInFolder = 0;

    for (const source of config.sources) {
      const sourcePath = path.join(PREPARED_DIR, source.file);
      const crops = await splitSourceIntoParts(sourcePath, source.count, source.cols, source.rows);

      for (const crop of crops) {
        const name = `${config.prefix}_${String(outputIndex).padStart(2, "0")}.png`;
        const outputPath = path.join(outputDir, name);

        await sharp(sourcePath).extract(crop).png().toFile(outputPath);
        outputIndex += 1;
        producedInFolder += 1;
        total += 1;
      }
    }

    summary[config.folder] = producedInFolder;
  }

  console.log(`Toplam uretilen parca: ${total}`);
  console.log("Klasor bazli ozet:");
  for (const [folder, count] of Object.entries(summary)) {
    console.log(`- parts/${folder}: ${count} dosya`);
  }
}

main().catch((error) => {
  console.error("Hata:", error.message);
  process.exit(1);
});
