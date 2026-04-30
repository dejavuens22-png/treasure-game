#!/usr/bin/env node

const fs = require("fs/promises");
const path = require("path");

let sharp;
try {
  sharp = require("sharp");
} catch (error) {
  console.error("sharp bulunamadi. Once su komutu calistir:");
  console.error("cd mobile && npm install sharp");
  process.exit(1);
}

const AVATAR_DIR = path.resolve(__dirname, "../assets/images/avatar");
const SOURCE_DIR = path.join(AVATAR_DIR, "source");
const PREPARED_DIR = path.join(AVATAR_DIR, "prepared");
const MANUAL_MAP_FILE = path.join(SOURCE_DIR, "manual-map.json");

const TARGET_FILES = [
  "female_base.png",
  "male_base.png",
  "hair_sheet.png",
  "eye_shapes_sheet.png",
  "face_types_sheet.png",
  "top_clothes_sheet.png",
  "bottom_clothes_sheet.png",
  "shoes_sheet.png",
  "eye_colors_sheet.png",
  "accessories_sheet.png",
];

const IMAGE_EXT_REGEX = /\.(png|jpe?g)$/i;
const AUTO_MATCH_THRESHOLD = 0.78;

function round(value, precision = 3) {
  return Number(value.toFixed(precision));
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function loadManualMap() {
  if (!(await pathExists(MANUAL_MAP_FILE))) {
    return {};
  }

  try {
    const raw = await fs.readFile(MANUAL_MAP_FILE, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("manual-map.json bir object olmali");
    }
    return parsed;
  } catch (error) {
    console.error(`manual-map.json okunamadi: ${error.message}`);
    process.exit(1);
  }
}

async function listSourceImages() {
  const sourceExists = await pathExists(SOURCE_DIR);
  if (!sourceExists) {
    console.error(`source klasoru bulunamadi: ${SOURCE_DIR}`);
    console.error("Lutfen avatar dosyalarini source klasorune koyup tekrar calistir.");
    process.exit(1);
  }

  const entries = await fs.readdir(SOURCE_DIR, { withFileTypes: true });
  const images = entries
    .filter((entry) => entry.isFile() && IMAGE_EXT_REGEX.test(entry.name))
    .map((entry) => path.join(SOURCE_DIR, entry.name));

  if (images.length === 0) {
    console.error("source klasorunde .png/.jpg/.jpeg dosyasi bulunamadi.");
    process.exit(1);
  }

  return images;
}

async function getImageInfo(filePath) {
  const image = sharp(filePath, { failOn: "none" });
  const metadata = await image.metadata();
  const stats = await image.stats();

  const width = metadata.width || 0;
  const height = metadata.height || 0;
  const area = width * height;
  const aspect = width > 0 ? height / width : 0;

  const channels = stats.channels || [];
  const r = channels[0]?.mean || 0;
  const g = channels[1]?.mean || 0;
  const b = channels[2]?.mean || 0;
  const alpha = channels[3]?.mean;
  const alphaRatio = typeof alpha === "number" ? alpha / 255 : 1;

  const rgbSpread = Math.max(r, g, b) - Math.min(r, g, b);
  const redBias = r - (g + b) / 2;
  const saturationApprox = rgbSpread / 255;

  return {
    filePath,
    baseName: path.basename(filePath),
    width,
    height,
    area,
    aspect: round(aspect),
    alphaRatio: round(alphaRatio),
    redBias: round(redBias),
    saturationApprox: round(saturationApprox),
  };
}

function scoreForTarget(info, target) {
  const reasons = [];
  let score = 0;

  const isPortrait = info.aspect > 1.2;
  const isSheet = info.aspect <= 1.2;
  const hasStrongAlpha = info.alphaRatio < 0.92;

  if (target === "female_base.png") {
    if (isPortrait) {
      score += 0.45;
      reasons.push("portrait");
    }
    if (info.redBias > 3) {
      score += 0.22;
      reasons.push("red-bias");
    }
    if (info.saturationApprox > 0.21) {
      score += 0.18;
      reasons.push("saturation");
    }
    if (info.area < 3_500_000) {
      score += 0.12;
      reasons.push("smaller-character-area");
    }
  }

  if (target === "male_base.png") {
    if (isPortrait) {
      score += 0.45;
      reasons.push("portrait");
    }
    if (info.redBias <= 3) {
      score += 0.22;
      reasons.push("low-red-bias");
    }
    if (info.saturationApprox <= 0.23) {
      score += 0.18;
      reasons.push("lower-saturation");
    }
    if (info.area >= 2_000_000) {
      score += 0.12;
      reasons.push("character-area");
    }
  }

  if (target === "hair_sheet.png") {
    if (isSheet) score += 0.28;
    if (hasStrongAlpha) score += 0.24;
    if (info.saturationApprox > 0.18) score += 0.2;
    if (info.area > 2_000_000) score += 0.18;
  }

  if (target === "eye_shapes_sheet.png") {
    if (isSheet) score += 0.3;
    if (info.saturationApprox < 0.17) score += 0.26;
    if (hasStrongAlpha) score += 0.18;
    if (info.area <= 2_000_000) score += 0.16;
  }

  if (target === "face_types_sheet.png") {
    if (isSheet) score += 0.25;
    if (Math.abs(info.redBias) < 8) score += 0.18;
    if (info.saturationApprox > 0.14 && info.saturationApprox < 0.3) score += 0.24;
    if (info.area > 2_000_000) score += 0.2;
  }

  if (target === "top_clothes_sheet.png") {
    if (isSheet) score += 0.25;
    if (info.area > 2_300_000) score += 0.22;
    if (info.saturationApprox > 0.2) score += 0.2;
    if (hasStrongAlpha) score += 0.14;
  }

  if (target === "bottom_clothes_sheet.png") {
    if (isSheet) score += 0.24;
    if (info.area > 1_700_000 && info.area < 3_300_000) score += 0.24;
    if (info.saturationApprox > 0.14 && info.saturationApprox < 0.28) score += 0.2;
    if (hasStrongAlpha) score += 0.14;
  }

  if (target === "shoes_sheet.png") {
    if (isSheet) score += 0.24;
    if (info.area < 2_300_000) score += 0.26;
    if (hasStrongAlpha) score += 0.22;
    if (info.saturationApprox > 0.15) score += 0.14;
  }

  if (target === "eye_colors_sheet.png") {
    if (isSheet) score += 0.24;
    if (info.saturationApprox > 0.24) score += 0.34;
    if (info.area < 2_100_000) score += 0.22;
    if (hasStrongAlpha) score += 0.1;
  }

  if (target === "accessories_sheet.png") {
    if (isSheet) score += 0.25;
    if (hasStrongAlpha) score += 0.28;
    if (info.area <= 2_600_000) score += 0.2;
    if (info.saturationApprox > 0.12) score += 0.15;
  }

  return { score: round(Math.min(score, 1)), reasons };
}

function autoMatch(infos, manualMap) {
  const assignments = new Map();
  const unmatched = new Set(infos.map((info) => info.filePath));
  const unmatchedTargets = new Set(TARGET_FILES);

  for (const info of infos) {
    const manualTarget = manualMap[info.baseName];
    if (!manualTarget) continue;
    if (!TARGET_FILES.includes(manualTarget)) {
      console.warn(
        `[uyari] manual-map: ${info.baseName} -> ${manualTarget} gecersiz hedef dosya ismi.`,
      );
      continue;
    }
    if (!unmatchedTargets.has(manualTarget)) {
      console.warn(
        `[uyari] manual-map: ${manualTarget} birden fazla dosyaya atanmis, ilk atama korunuyor.`,
      );
      continue;
    }
    assignments.set(manualTarget, {
      info,
      confidence: 1,
      method: "manual-map",
      reasons: ["manual-map"],
    });
    unmatched.delete(info.filePath);
    unmatchedTargets.delete(manualTarget);
  }

  const candidates = [];
  for (const info of infos) {
    if (!unmatched.has(info.filePath)) continue;
    for (const target of unmatchedTargets) {
      const { score, reasons } = scoreForTarget(info, target);
      candidates.push({ info, target, score, reasons });
    }
  }

  candidates.sort((a, b) => b.score - a.score);
  const usedFiles = new Set();

  for (const candidate of candidates) {
    if (candidate.score < AUTO_MATCH_THRESHOLD) continue;
    if (!unmatchedTargets.has(candidate.target)) continue;
    if (usedFiles.has(candidate.info.filePath)) continue;

    assignments.set(candidate.target, {
      info: candidate.info,
      confidence: candidate.score,
      method: "auto",
      reasons: candidate.reasons,
    });
    unmatchedTargets.delete(candidate.target);
    unmatched.delete(candidate.info.filePath);
    usedFiles.add(candidate.info.filePath);
  }

  return {
    assignments,
    unmatchedFiles: infos.filter((info) => unmatched.has(info.filePath)),
    unmatchedTargets: Array.from(unmatchedTargets),
  };
}

async function ensurePreparedDir() {
  await fs.mkdir(PREPARED_DIR, { recursive: true });
}

async function convertAndWrite(sourcePath, destinationPath) {
  await sharp(sourcePath, { failOn: "none" }).png().toFile(destinationPath);
}

function printAnalysis(infos) {
  console.log("\n[analiz] source klasorundeki dosyalar:");
  for (const info of infos) {
    console.log(
      `- ${info.baseName} | ${info.width}x${info.height} | aspect=${info.aspect} | alpha=${info.alphaRatio} | sat=${info.saturationApprox} | redBias=${info.redBias}`,
    );
  }
}

async function main() {
  const manualMap = await loadManualMap();
  const imagePaths = await listSourceImages();
  const infos = await Promise.all(imagePaths.map(getImageInfo));
  printAnalysis(infos);

  await ensurePreparedDir();
  const { assignments, unmatchedFiles, unmatchedTargets } = autoMatch(infos, manualMap);

  console.log("\n[hazirlik] eslesen dosyalar:");
  for (const targetName of TARGET_FILES) {
    const match = assignments.get(targetName);
    if (!match) continue;
    const destinationPath = path.join(PREPARED_DIR, targetName);
    await convertAndWrite(match.info.filePath, destinationPath);
    console.log(
      `- ${path.basename(match.info.filePath)} -> ${targetName} (${match.method}, confidence=${match.confidence})`,
    );
  }

  if (unmatchedFiles.length > 0 || unmatchedTargets.length > 0) {
    console.log("\n[MANUAL CHECK]");
    if (unmatchedFiles.length > 0) {
      console.log("Eslesmeyen kaynak dosyalar:");
      for (const info of unmatchedFiles) {
        console.log(`MANUAL CHECK NEEDED: ${info.baseName}`);
      }
    }
    if (unmatchedTargets.length > 0) {
      console.log("Doldurulamayan hedef dosya adlari:");
      for (const target of unmatchedTargets) {
        console.log(`- ${target}`);
      }
    }
    console.log("\nIstersen source/manual-map.json olusturup manuel map verebilirsin:");
    console.log('{');
    console.log('  "kaynak_dosya_adi.jpeg": "female_base.png"');
    console.log("}");
  } else {
    console.log("\nTum dosyalar otomatik esitlendi ve prepared klasorune PNG olarak yazildi.");
  }
}

main().catch((error) => {
  console.error("\nHata:", error.message);
  process.exit(1);
});
