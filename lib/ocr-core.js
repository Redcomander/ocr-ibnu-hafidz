const fs = require('fs');
const sharp = require('sharp');
const { createWorker } = require('tesseract.js');

const DEFAULT_OPTION_LABELS = ['A', 'B', 'C', 'D', 'E'];
const CALIBRATION_PRESETS = {
  30: {
    markedThreshold: 45,
    confidenceGap: 2.5,
    questionColW: 0.1,
    centerPadX: 0.15,
    centerPadY: 0.2,
    blocks: [
      { startQ: 1, count: 10, x: 0.12, y: 0.37, w: 0.27, h: 0.32, questionColW: 0.1, rowTop: 0, rowBottom: 1 },
      { startQ: 11, count: 10, x: 0.43, y: 0.37, w: 0.27, h: 0.32, questionColW: 0.1, rowTop: 0, rowBottom: 1 },
      { startQ: 21, count: 10, x: 0.73, y: 0.37, w: 0.23, h: 0.32, questionColW: 0.1, rowTop: 0, rowBottom: 1 },
    ],
  },
  35: {
    markedThreshold: 45,
    confidenceGap: 2.5,
    questionColW: 0.1,
    centerPadX: 0.15,
    centerPadY: 0.2,
    blocks: [
      { startQ: 1, count: 10, x: 0.12, y: 0.37, w: 0.27, h: 0.32, questionColW: 0.1, rowTop: 0, rowBottom: 1 },
      { startQ: 11, count: 10, x: 0.43, y: 0.37, w: 0.27, h: 0.32, questionColW: 0.1, rowTop: 0, rowBottom: 1 },
      { startQ: 21, count: 10, x: 0.73, y: 0.37, w: 0.23, h: 0.32, questionColW: 0.1, rowTop: 0, rowBottom: 1 },
      { startQ: 31, count: 5, x: 0.12, y: 0.68, w: 0.27, h: 0.19, questionColW: 0.1, rowTop: 0, rowBottom: 1 },
    ],
  },
  50: {
    markedThreshold: 45,
    confidenceGap: 2.5,
    questionColW: 0.1,
    centerPadX: 0.15,
    centerPadY: 0.2,
    blocks: [
      { startQ: 1, count: 10, x: 0.12, y: 0.37, w: 0.27, h: 0.32, questionColW: 0.1, rowTop: 0, rowBottom: 1 },
      { startQ: 11, count: 10, x: 0.43, y: 0.37, w: 0.27, h: 0.32, questionColW: 0.1, rowTop: 0, rowBottom: 1 },
      { startQ: 21, count: 10, x: 0.73, y: 0.37, w: 0.23, h: 0.32, questionColW: 0.1, rowTop: 0, rowBottom: 1 },
      { startQ: 31, count: 10, x: 0.12, y: 0.64, w: 0.27, h: 0.32, questionColW: 0.1, rowTop: 0, rowBottom: 1 },
      { startQ: 41, count: 10, x: 0.43, y: 0.64, w: 0.27, h: 0.32, questionColW: 0.1, rowTop: 0, rowBottom: 1 },
    ],
  },
};

function normalizeQuestionTotal(total = 35) {
  const parsed = Number(total);
  if (parsed <= 30) {
    return 30;
  }
  if (parsed <= 35) {
    return 35;
  }
  return 50;
}

function normalizeOptionChoices(optionChoices = 'ABCDE') {
  const cleaned = String(optionChoices || '')
    .toUpperCase()
    .replace(/[^A-Z]/g, '');

  if (cleaned === 'ABCD') {
    return 'ABCD';
  }

  return 'ABCDE';
}

function getOptionLabels(optionChoices = 'ABCDE') {
  return normalizeOptionChoices(optionChoices).split('');
}

function getCalibrationPreset(total = 35) {
  return cloneCalibration(CALIBRATION_PRESETS[normalizeQuestionTotal(total)] || CALIBRATION_PRESETS[35]);
}

const DEFAULT_CALIBRATION = getCalibrationPreset(35);

function asDataUrl(buffer) {
  return `data:image/png;base64,${buffer.toString('base64')}`;
}

function cloneCalibration(calibration) {
  return {
    ...calibration,
    blocks: calibration.blocks.map((block) => ({ ...block })),
  };
}

function clampNumber(value, min, max, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, parsed));
}

function buildUniformBands(segmentCount) {
  const safeCount = Math.max(1, Number(segmentCount) || 1);
  return Array.from({ length: safeCount + 1 }, (_, index) => Number((index / safeCount).toFixed(4)));
}

function sanitizeBands(inputBands, segmentCount, minGap = 0.02) {
  const safeCount = Math.max(1, Number(segmentCount) || 1);
  const fallback = buildUniformBands(safeCount);

  if (!Array.isArray(inputBands) || inputBands.length !== safeCount + 1) {
    return fallback;
  }

  const parsed = inputBands.map((value) => Number(value));
  if (parsed.some((value) => !Number.isFinite(value))) {
    return fallback;
  }

  const out = new Array(safeCount + 1);
  out[0] = 0;
  out[safeCount] = 1;

  for (let index = 1; index < safeCount; index += 1) {
    const min = out[index - 1] + minGap;
    const max = 1 - (safeCount - index) * minGap;
    out[index] = Math.min(max, Math.max(min, parsed[index]));
  }

  return out.map((value) => Number(value.toFixed(4)));
}

function sanitizeCalibration(input = {}, totalQuestions = 35, optionChoices = 'ABCDE') {
  const merged = getCalibrationPreset(totalQuestions);
  const optionLabels = getOptionLabels(optionChoices);
  merged.optionChoices = normalizeOptionChoices(optionChoices);

  merged.markedThreshold = clampNumber(input.markedThreshold, 0, 255, merged.markedThreshold);
  merged.confidenceGap = clampNumber(input.confidenceGap, 0, 255, merged.confidenceGap);
  merged.questionColW = clampNumber(input.questionColW, 0.01, 0.5, merged.questionColW);
  merged.centerPadX = clampNumber(input.centerPadX, 0, 0.45, merged.centerPadX);
  merged.centerPadY = clampNumber(input.centerPadY, 0, 0.45, merged.centerPadY);

  if (Array.isArray(input.blocks)) {
    merged.blocks = merged.blocks.map((block, index) => {
      const source = input.blocks[index] || {};
      const safeCount = clampNumber(source.count, 1, 100, block.count);
      return {
        ...block,
        startQ: clampNumber(source.startQ, 1, 500, block.startQ),
        count: safeCount,
        x: clampNumber(source.x, 0, 1, block.x),
        y: clampNumber(source.y, 0, 1, block.y),
        w: clampNumber(source.w, 0.01, 1, block.w),
        h: clampNumber(source.h, 0.01, 1, block.h),
        questionColW: clampNumber(source.questionColW, 0.01, 0.45, block.questionColW ?? merged.questionColW),
        rowTop: clampNumber(source.rowTop, 0, 0.9, block.rowTop ?? 0),
        rowBottom: clampNumber(source.rowBottom, 0.1, 1, block.rowBottom ?? 1),
        optionBands: sanitizeBands(source.optionBands ?? block.optionBands, optionLabels.length, 0.04),
        rowBands: sanitizeBands(source.rowBands ?? block.rowBands, safeCount, 0.02),
      };
    });
  }

  merged.blocks = merged.blocks.map((block) => {
    const safeTop = Math.min(block.rowTop, block.rowBottom - 0.05);
    const safeBottom = Math.max(block.rowBottom, safeTop + 0.05);
    return {
      ...block,
      rowTop: Number(safeTop.toFixed(4)),
      rowBottom: Number(Math.min(1, safeBottom).toFixed(4)),
      optionBands: sanitizeBands(block.optionBands, optionLabels.length, 0.04),
      rowBands: sanitizeBands(block.rowBands, block.count, 0.02),
    };
  });

  return merged;
}

function sanitizeRotation(rotation) {
  const parsed = Number(rotation);
  if (!Number.isFinite(parsed)) {
    return 0;
  }

  const snapped = Math.round(parsed / 90) * 90;
  return ((snapped % 360) + 360) % 360;
}

function createNormalizedPipeline(inputBuffer, rotation = 0) {
  return sharp(inputBuffer).rotate().rotate(sanitizeRotation(rotation));
}

function computeGrayStats(rawBuffer) {
  if (!rawBuffer || !rawBuffer.length) {
    return { mean: 0, stdDev: 0, darkRatio: 0, brightRatio: 0 };
  }

  let sum = 0;
  let sumSq = 0;
  let dark = 0;
  let bright = 0;
  const total = rawBuffer.length;

  for (let i = 0; i < total; i += 1) {
    const v = rawBuffer[i];
    sum += v;
    sumSq += v * v;
    if (v < 70) dark += 1;
    if (v > 200) bright += 1;
  }

  const mean = sum / total;
  const variance = Math.max(0, sumSq / total - mean * mean);
  return {
    mean,
    stdDev: Math.sqrt(variance),
    darkRatio: dark / total,
    brightRatio: bright / total,
  };
}

function deriveAdaptiveThreshold(stats) {
  // Enhanced LJK adaptive threshold for better mark detection
  let threshold = 165;

  // Adjust for mean brightness
  if (stats.mean < 140) {
    threshold -= 12;
  }
  if (stats.mean < 120) {
    threshold -= 10;
  }
  if (stats.mean < 100) {
    threshold -= 8;
  }

  // Adjust for low contrast (low standard deviation)
  if (stats.stdDev < 38) {
    threshold -= 10;
  }
  if (stats.stdDev < 28) {
    threshold -= 8;
  }

  // Adjust for high dark ratio (shadow/low-light)
  if (stats.darkRatio > 0.45) {
    threshold -= 6;
  }
  if (stats.darkRatio > 0.55) {
    threshold -= 8;
  }

  // Boost for very bright papers
  if (stats.mean > 210 && stats.stdDev > 45) {
    threshold += 5;
  }

  return Math.max(110, Math.min(190, Math.round(threshold)));
}

function isLowLightOrShadow(stats) {
  return stats.mean < 120 || stats.darkRatio > 0.4 || stats.stdDev < 36;
}

async function preprocessImage(inputBuffer, rotation = 0, options = {}) {
  const threshold = Number.isFinite(Number(options.threshold)) ? Number(options.threshold) : 165;
  const lowLightMode = Boolean(options.lowLightMode);

  let pipeline = createNormalizedPipeline(inputBuffer, rotation)
    .grayscale()
    .normalize();

  if (lowLightMode) {
    // Raise darker regions and improve edge contrast for shadows/low light.
    pipeline = pipeline
      .gamma(1.22)
      .linear(1.08, -6)
      .sharpen({ sigma: 1.1, m1: 1.2, m2: 0.8 });
  }

  return pipeline
    .median(1)
    .threshold(threshold)
    .toBuffer();
}

function normalizeText(text) {
  return String(text || '')
    .toUpperCase()
    .replace(/\|/g, ' ')
    .replace(/[^A-Z0-9.\s]/g, ' ')
    .trim();
}

function buildMissing(parsedMap, totalQuestions) {
  const missing = [];
  for (let index = 1; index <= totalQuestions; index += 1) {
    if (!parsedMap.has(index)) {
      missing.push(index);
    }
  }
  return missing;
}

function parseAnswers(text, totalQuestions = 35, optionChoices = 'ABCDE') {
  const optionPattern = getOptionLabels(optionChoices).join('');
  const normalized = normalizeText(text);
  const pattern = new RegExp(`(?<!\\d)(\\d{1,2})\\s*[.)-]?\\s*([${optionPattern}])(?![A-Z])`, 'g');
  const parsed = new Map();
  const duplicates = new Map();
  let match;

  while ((match = pattern.exec(normalized)) !== null) {
    const qn = Number(match[1]);
    const ans = match[2];

    if (qn < 1 || qn > totalQuestions) {
      continue;
    }

    if (parsed.has(qn) && parsed.get(qn) !== ans) {
      if (!duplicates.has(qn)) {
        duplicates.set(qn, [parsed.get(qn)]);
      }
      duplicates.get(qn).push(ans);
      continue;
    }

    parsed.set(qn, ans);
  }

  return { parsed, duplicates, missing: buildMissing(parsed, totalQuestions), normalized };
}

function loadAnswerKey(keyPath) {
  const payload = JSON.parse(fs.readFileSync(keyPath, 'utf-8'));
  const key = new Map();

  Object.entries(payload).forEach(([k, v]) => {
    key.set(Number(k), String(v).trim().toUpperCase());
  });

  return key;
}

function compareAnswers(predicted, expected) {
  let expectedMap;
  if (expected instanceof Map) {
    expectedMap = expected;
  } else if (expected && typeof expected === 'object') {
    expectedMap = new Map();
    Object.entries(expected).forEach(([k, v]) => {
      const qn = Number(k);
      if (Number.isFinite(qn) && qn > 0) {
        expectedMap.set(qn, String(v || '').trim().toUpperCase());
      }
    });
  } else {
    expectedMap = new Map();
  }

  let correct = 0;
  let wrong = 0;
  const details = {};

  expectedMap.forEach((answer, qn) => {
    const got = predicted.get(qn) || null;
    const isCorrect = got === answer;
    details[qn] = { expected: answer, actual: got, correct: isCorrect };

    if (isCorrect) {
      correct += 1;
    } else {
      wrong += 1;
    }
  });

  const total = expectedMap.size;
  const score = total ? (correct / total) * 100 : 0;

  return { correct, wrong, total, score, details };
}

async function runOcr(imageBuffer, lang = 'eng') {
  const worker = await createWorker(lang);

  try {
    const {
      data: { text },
    } = await worker.recognize(imageBuffer);
    return text || '';
  } finally {
    await worker.terminate();
  }
}

async function toRawGray(inputBuffer, width = 1200, rotation = 0) {
  const normalized = createNormalizedPipeline(inputBuffer, rotation).grayscale().normalize();
  const metadata = await normalized.metadata();
  const targetWidth = metadata.width && metadata.width > width ? width : metadata.width || width;
  const { data, info } = await normalized.resize({ width: targetWidth }).raw().toBuffer({ resolveWithObject: true });

  return { data, width: info.width, height: info.height };
}

async function toRawGrayEnhanced(inputBuffer, width = 1200, rotation = 0) {
  const enhanced = createNormalizedPipeline(inputBuffer, rotation)
    .grayscale()
    .normalize()
    .gamma(1.22)
    .linear(1.08, -6)
    .sharpen({ sigma: 1.1, m1: 1.2, m2: 0.8 });
  const metadata = await enhanced.metadata();
  const targetWidth = metadata.width && metadata.width > width ? width : metadata.width || width;
  const { data, info } = await enhanced.resize({ width: targetWidth }).raw().toBuffer({ resolveWithObject: true });

  return { data, width: info.width, height: info.height };
}

async function buildProcessedPreview(inputBuffer, width = 1200, rotation = 0) {
  return createNormalizedPipeline(inputBuffer, rotation)
    .resize({ width, withoutEnlargement: true })
    .grayscale()
    .normalize()
    .median(1)
    .threshold(165)
    .png()
    .toBuffer();
}

async function buildSourcePreview(inputBuffer, width = 1200, rotation = 0) {
  return createNormalizedPipeline(inputBuffer, rotation)
    .resize({ width, withoutEnlargement: true })
    .png()
    .toBuffer();
}

async function buildGrayPreview(raw, width, height) {
  return sharp(raw, { raw: { width, height, channels: 1 } }).png().toBuffer();
}

function meanDarkness(raw, width, x1, y1, x2, y2) {
  const left = Math.max(0, Math.min(width - 1, Math.floor(x1)));
  const right = Math.max(left + 1, Math.floor(x2));
  const top = Math.max(0, Math.floor(y1));
  const bottom = Math.max(top + 1, Math.floor(y2));
  let count = 0;
  let sum = 0;

  for (let y = top; y < bottom; y += 1) {
    const row = y * width;
    for (let x = left; x < right; x += 1) {
      sum += 255 - raw[row + x];
      count += 1;
    }
  }

  return count ? sum / count : 0;
}

function analyzeMarkCell(raw, width, x1, y1, x2, y2) {
  const left = Math.max(0, Math.min(width - 1, Math.floor(x1)));
  const right = Math.max(left + 1, Math.floor(x2));
  const top = Math.max(0, Math.floor(y1));
  const bottom = Math.max(top + 1, Math.floor(y2));

  let count = 0;
  let darknessSum = 0;
  let darknessSqSum = 0;
  let darkPixels = 0;

  for (let y = top; y < bottom; y += 1) {
    const row = y * width;
    for (let x = left; x < right; x += 1) {
      const darkness = 255 - raw[row + x];
      darknessSum += darkness;
      darknessSqSum += darkness * darkness;
      if (darkness >= 120) {
        darkPixels += 1;
      }
      count += 1;
    }
  }

  if (!count) {
    return { darkness: 0, darkRatio: 0, darkStdDev: 0 };
  }

  const darkness = darknessSum / count;
  const variance = Math.max(0, darknessSqSum / count - darkness * darkness);
  return {
    darkness,
    darkRatio: darkPixels / count,
    darkStdDev: Math.sqrt(variance),
  };
}

/**
 * Derive adaptive marked threshold based on image statistics.
 * This makes block detection more adaptive to different lighting and paper conditions.
 */
function deriveAdaptiveMarkedThreshold(stats, baseThreshold = 45) {
  let threshold = baseThreshold;

  // Adjust for dark images - lower threshold needed for well-marked bubbles
  if (stats.mean < 100) {
    threshold -= 8;
  } else if (stats.mean < 120) {
    threshold -= 5;
  } else if (stats.mean < 140) {
    threshold -= 3;
  }

  // High contrast papers need adjusted thresholds
  if (stats.stdDev > 60) {
    threshold += 3; // Increase for very high contrast
  } else if (stats.stdDev < 25) {
    threshold -= 5; // Decrease for low contrast (faint marks)
  }

  // Compensate for high dark ratio (shadows, low light)
  if (stats.darkRatio > 0.5) {
    threshold -= 6;
  }

  return Math.max(20, Math.min(80, Math.round(threshold)));
}

function detectChoiceInRow({ raw, width, rowRect, optionsStartX, optionsWidth, calibration, optionBands, optionLabels, imageStats, centerPadXOverride, centerPadYOverride, markedThresholdBoost = 0 }) {
  const safeOptionBands = sanitizeBands(optionBands, optionLabels.length, 0.04);
  const rowH = rowRect.y2 - rowRect.y1;
  
  // Use adaptive marked threshold if image stats are provided
  const adaptiveMarkedThresholdBase = imageStats ? deriveAdaptiveMarkedThreshold(imageStats, calibration.markedThreshold) : calibration.markedThreshold;
  const adaptiveMarkedThreshold = Math.max(20, Math.min(95, adaptiveMarkedThresholdBase + Number(markedThresholdBoost || 0)));
  
  const optionScores = optionLabels.map((label, index) => {
    const xCell1 = optionsStartX + optionsWidth * safeOptionBands[index];
    const xCell2 = optionsStartX + optionsWidth * safeOptionBands[index + 1];
    const colW = Math.max(2, xCell2 - xCell1);
    const centerPadXRatio = Number.isFinite(Number(centerPadXOverride)) ? Number(centerPadXOverride) : Number(calibration.centerPadX || 0.15);
    const centerPadYRatio = Number.isFinite(Number(centerPadYOverride)) ? Number(centerPadYOverride) : Number(calibration.centerPadY || 0.2);
    const centerPadX = colW * centerPadXRatio;
    const centerPadY = rowH * centerPadYRatio;
    const rect = {
      x1: xCell1 + centerPadX,
      y1: rowRect.y1 + centerPadY,
      x2: xCell2 - centerPadX,
      y2: rowRect.y2 - centerPadY,
    };
    const cellStats = analyzeMarkCell(raw, width, rect.x1, rect.y1, rect.x2, rect.y2);

    const fullFillDarknessThreshold = Math.max(adaptiveMarkedThreshold * 1.15, 52);
    const xMarkDarknessThreshold = Math.max(adaptiveMarkedThreshold * 0.52, 20);
    const isFullFill =
      cellStats.darkRatio >= 0.68
      && cellStats.darkness >= fullFillDarknessThreshold
      && cellStats.darkStdDev <= 58;
    const isXMark =
      cellStats.darkness >= xMarkDarknessThreshold
      && cellStats.darkRatio >= 0.07
      && cellStats.darkRatio <= 0.78
      && cellStats.darkStdDev >= 18;

    // Prefer sparse+textured strokes (X-like) over dense blocks.
    const xShapeScore =
      (cellStats.darkness * 0.7)
      + (cellStats.darkStdDev * 0.45)
      - (Math.abs(cellStats.darkRatio - 0.33) * 42);

    return {
      label,
      darkness: cellStats.darkness,
      darkRatio: cellStats.darkRatio,
      darkStdDev: cellStats.darkStdDev,
      xShapeScore,
      markType: isFullFill ? 'full-fill' : (isXMark ? 'x-mark' : 'none'),
      rect,
    };
  });

  // Per-row baseline normalization makes selection less sensitive to page shadow
  // and paper tone changes that darken all options in the same row.
  const rowDarknessSorted = optionScores
    .map((option) => option.darkness)
    .sort((a, b) => a - b);
  const rowDarknessBaseline = rowDarknessSorted[Math.floor(rowDarknessSorted.length / 2)] || 0;

  optionScores.forEach((option) => {
    option.adjustedDarkness = Math.max(0, option.darkness - rowDarknessBaseline * 0.9);
    option.intentScore =
      (option.adjustedDarkness * 1.0)
      + (option.darkStdDev * 0.42)
      - (Math.abs(option.darkRatio - 0.30) * 34)
      - (Math.max(0, option.darkRatio - 0.72) * 82);
  });

  const ranked = [...optionScores].sort((a, b) => b.adjustedDarkness - a.adjustedDarkness);
  const marked = ranked[0];
  const second = ranked[1] || { adjustedDarkness: 0 };
  const confidence = marked.adjustedDarkness - second.adjustedDarkness;

  const xCandidates = optionScores
    .filter((option) => option.markType === 'x-mark' || (option.darkStdDev >= 17 && option.darkRatio >= 0.06 && option.darkRatio <= 0.85))
    .sort((a, b) => b.intentScore - a.intentScore);
  const xBest = xCandidates[0] || null;
  const xSecond = xCandidates[1] || null;
  const hasCrossedOutFullFill = ranked.some((option) => option.markType === 'full-fill' && option.label !== xBest?.label && option.adjustedDarkness >= Math.max(adaptiveMarkedThreshold * 0.18, 8));

  let choice = null;
  let method = 'find-marked';

  if (xBest) {
    const xConfidence = xBest.intentScore - (xSecond ? xSecond.intentScore : 0);
    if (xBest.adjustedDarkness >= Math.max(adaptiveMarkedThreshold * 0.13, 5) && xConfidence >= 0.85) {
      choice = xBest.label;
      method = hasCrossedOutFullFill ? 'x-mark-correction' : 'x-mark';
    }

    // Strong correction heuristic: if there is an old full-fill in another option,
    // and we still see a textured X-like mark, prefer the new X intent.
    if (!choice && hasCrossedOutFullFill && xBest.darkStdDev >= 18 && xBest.darkRatio >= 0.06 && xBest.darkRatio <= 0.82) {
      choice = xBest.label;
      method = 'x-mark-correction';
    }
  }

  if (!choice) {
    const effectiveConfidenceGap = Math.max(Number(calibration.confidenceGap || 2.5), 2.2);
    choice = marked.adjustedDarkness > Math.max(adaptiveMarkedThreshold * 0.2, 8)
      && (marked.darkRatio >= 0.08 || marked.darkStdDev >= 16)
      && confidence > effectiveConfidenceGap
      ? marked.label
      : null;
  }

  return {
    choice,
    method,
    markedDarkness: Number(marked.darkness.toFixed(2)),
    confidence: Number(confidence.toFixed(2)),
    adaptiveThreshold: Number(adaptiveMarkedThreshold.toFixed(0)),
    optionScores: optionScores.map((option) => ({
      label: option.label,
      darkness: Number(option.darkness.toFixed(2)),
      adjustedDarkness: Number((option.adjustedDarkness || 0).toFixed(2)),
      darkRatio: Number(option.darkRatio.toFixed(3)),
      darkStdDev: Number(option.darkStdDev.toFixed(2)),
      xShapeScore: Number(option.xShapeScore.toFixed(2)),
      intentScore: Number((option.intentScore || 0).toFixed(2)),
      markType: option.markType,
      rect: {
        x1: Number(option.rect.x1.toFixed(1)),
        y1: Number(option.rect.y1.toFixed(1)),
        x2: Number(option.rect.x2.toFixed(1)),
        y2: Number(option.rect.y2.toFixed(1)),
      },
    })),
  };
}

function getBlockScanOverrides(block, calibration) {
  const overrides = {
    questionColWRatio: Number(block?.questionColW ?? calibration.questionColW ?? 0.1),
    centerPadXRatio: Number(calibration.centerPadX ?? 0.15),
    centerPadYRatio: Number(calibration.centerPadY ?? 0.2),
    markedThresholdBoost: 0,
  };

  // Middle top block (Q11-Q20) is usually most affected by perspective + shadows,
  // so sample deeper inside bubbles and avoid number-column bleed.
  if (Number(block?.startQ) === 11 && Number(block?.count) >= 10) {
    overrides.questionColWRatio = Math.min(0.18, overrides.questionColWRatio + 0.012);
    overrides.centerPadXRatio = Math.min(0.32, overrides.centerPadXRatio + 0.04);
    overrides.centerPadYRatio = Math.min(0.32, overrides.centerPadYRatio + 0.03);
    overrides.markedThresholdBoost = 2;
  }

  return overrides;
}

function colorForScore(darkness, maxDarkness) {
  const ratio = maxDarkness > 0 ? darkness / maxDarkness : 0;
  const hue = Math.round(200 - ratio * 190);
  const alpha = (0.12 + ratio * 0.48).toFixed(2);
  return { hue, alpha };
}

async function buildDebugOverlay(grayPreviewBuffer, diagnostics, width, height, mode = 'standard') {
  const maxDarkness = diagnostics
    .flatMap((row) => row.optionScores || [])
    .reduce((max, option) => Math.max(max, option.darkness), 0);

  const overlayMarkup = `
    <svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">
      <style>
        .label { font: 11px sans-serif; fill: #111827; }
        .badge { font: 12px sans-serif; font-weight: 700; fill: #111827; }
        .badge-bg { fill: rgba(255,255,255,0.88); stroke: rgba(17,24,39,0.15); stroke-width: 1; }
      </style>
      ${diagnostics
        .flatMap((row) => {
          const cells = (row.optionScores || []).map((option) => {
            const widthRect = Math.max(1, option.rect.x2 - option.rect.x1);
            const heightRect = Math.max(1, option.rect.y2 - option.rect.y1);
            const { hue, alpha } = colorForScore(option.darkness, maxDarkness);
            const isSelected = row.choice === option.label;
            const stroke = mode === 'heatmap'
              ? `hsla(${hue}, 88%, 42%, 0.95)`
              : isSelected
                ? 'rgba(22, 163, 74, 0.98)'
                : 'rgba(14, 165, 233, 0.45)';
            const fill = mode === 'heatmap'
              ? `hsla(${hue}, 90%, 55%, ${alpha})`
              : isSelected
                ? 'rgba(34, 197, 94, 0.22)'
                : 'rgba(255,255,255,0.03)';

            return `
              <rect x="${option.rect.x1}" y="${option.rect.y1}" width="${widthRect}" height="${heightRect}" rx="2" fill="${fill}" stroke="${stroke}" stroke-width="${isSelected ? 2 : 1}" />
              <text class="label" x="${option.rect.x1 + 2}" y="${option.rect.y1 + 12}">${option.label}:${option.darkness}</text>
            `;
          });

          const anchor = row.optionScores?.[0]?.rect;
          const badge = anchor
            ? `
              <rect class="badge-bg" x="${Math.max(0, anchor.x1 - 30)}" y="${Math.max(0, anchor.y1 - 16)}" width="28" height="14" rx="3" />
              <text class="badge" x="${Math.max(2, anchor.x1 - 27)}" y="${Math.max(10, anchor.y1 - 5)}">${row.qn}</text>
            `
            : '';

          return [...cells, badge];
        })
        .join('')}
    </svg>`;

  return sharp(grayPreviewBuffer).composite([{ input: Buffer.from(overlayMarkup), blend: 'over' }]).png().toBuffer();
}

/**
 * Detect which blocks are actually visible in the image.
 * A block is considered visible if it has sufficient content density.
 * This helps handle partial scans where only certain sections are present.
 */
function detectVisibleBlocks(raw, width, height, calibration) {
  const visibleBlocks = [];
  const minimumContentDensity = 0.025; // Be tolerant: partial crops often contain little ink

  calibration.blocks.forEach((block) => {
    const bx1 = Math.max(0, Math.floor(block.x * width));
    const by1 = Math.max(0, Math.floor(block.y * height));
    const bx2 = Math.min(width - 1, Math.ceil((block.x + block.w) * width));
    const by2 = Math.min(height - 1, Math.ceil((block.y + block.h) * height));

    // Check if block is within image bounds
    if (bx2 <= bx1 || by2 <= by1) {
      return; // Block is outside image
    }

    let darkPixels = 0;
    const totalPixels = (bx2 - bx1) * (by2 - by1);

    for (let y = by1; y < by2; y += 1) {
      for (let x = bx1; x < bx2; x += 1) {
        const pixel = raw[y * width + x];
        if (pixel < 200) { // Non-white pixel
          darkPixels += 1;
        }
      }
    }

    const contentDensity = darkPixels / Math.max(1, totalPixels);
    if (contentDensity >= minimumContentDensity) {
      visibleBlocks.push({
        ...block,
        contentDensity,
        isVisible: true,
      });
    }
  });

  // Fallback: if no blocks pass density filter, keep original blocks to avoid hard failure.
  if (!visibleBlocks.length) {
    return (calibration.blocks || []).map((block) => ({
      ...block,
      contentDensity: 0,
      isVisible: true,
    }));
  }

  return visibleBlocks;
}

/**
 * Adapt calibration based on visible content.
 * For partial scans, filter out blocks that aren't visible.
 * This improves accuracy when only part of the sheet is scanned.
 */
function adaptCalibrationForPartialScan(calibration, visibleBlocks) {
  const adapted = cloneCalibration(calibration);
  adapted.blocks = visibleBlocks.filter((block) => block.isVisible);
  return adapted;
}

/**
 * Detect LJK section from visible blocks.
 * Returns information about which section(s) of the sheet are present.
 * Sections: A = Pilihan Ganda (blocks 1-3), B = Uraian/Essay (remaining blocks)
 */
function detectLJKSection(visibleBlocks, calibration) {
  if (!visibleBlocks || visibleBlocks.length === 0) {
    return { section: 'unknown', hasMultipleChoice: false, hasEssay: false };
  }

  const allBlocks = calibration.blocks || [];
  // In current LJK preset, Pilihan Ganda is the first row blocks (y around 0.37).
  // Use geometric rule instead of object identity comparison.
  const hasMultipleChoice = visibleBlocks.some((b) => Number(b.y || 0) < 0.58);
  const hasEssay = visibleBlocks.some((b) => Number(b.y || 0) >= 0.58);

  let section = 'unknown';
  if (hasMultipleChoice && !hasEssay) {
    section = 'A_pilihan_ganda'; // Pilihan Ganda only
  } else if (hasEssay && !hasMultipleChoice) {
    section = 'B_essay'; // Essay only
  } else if (hasMultipleChoice && hasEssay) {
    section = 'AB_complete'; // Full sheet
  }

  return {
    section,
    hasMultipleChoice,
    hasEssay,
    visibleBlockCount: visibleBlocks.length,
    visibleBlockStartQ: visibleBlocks.map((b) => Number(b.startQ || 0)).filter((n) => Number.isFinite(n) && n > 0),
  };
}

function detectAnswersFromSheetLayout(raw, width, height, totalQuestions, calibration, optionChoices = 'ABCDE', imageStats = null) {
  const answers = new Map();
  const diagnostics = [];
  const optionLabels = getOptionLabels(optionChoices);

  // Detect which blocks are visible for partial scan support
  const visibleBlocks = detectVisibleBlocks(raw, width, height, calibration);
  const sectionInfo = detectLJKSection(visibleBlocks, calibration);
  const adaptedCalibration = adaptCalibrationForPartialScan(calibration, visibleBlocks);

  // Use adapted calibration with only visible blocks
  adaptedCalibration.blocks.forEach((block) => {
    const bx1 = block.x * width;
    const by1 = block.y * height;
    const bw = block.w * width;
    const bh = block.h * height;
    const blockScanOverrides = getBlockScanOverrides(block, calibration);
    const questionColW = bw * blockScanOverrides.questionColWRatio;
    const optionsStartX = bx1 + questionColW;
    const optionsWidth = bw - questionColW;
    const rowTop = by1 + bh * (block.rowTop ?? 0);
    const rowBottom = by1 + bh * (block.rowBottom ?? 1);
    const usableHeight = Math.max(8, rowBottom - rowTop);
    const rowBands = sanitizeBands(block.rowBands, block.count, 0.02);
    const optionBands = sanitizeBands(block.optionBands, optionLabels.length, 0.04);

    for (let index = 0; index < block.count; index += 1) {
      const qn = block.startQ + index;
      if (qn > totalQuestions) {
        break;
      }

      const rowRect = {
        y1: rowTop + usableHeight * rowBands[index],
        y2: rowTop + usableHeight * rowBands[index + 1],
      };

      const rowResult = detectChoiceInRow({
        raw,
        width,
        rowRect,
        optionsStartX,
        optionsWidth,
        calibration,
        optionBands,
        optionLabels,
        imageStats,
        centerPadXOverride: blockScanOverrides.centerPadXRatio,
        centerPadYOverride: blockScanOverrides.centerPadYRatio,
        markedThresholdBoost: blockScanOverrides.markedThresholdBoost,
      });

      if (rowResult.choice) {
        answers.set(qn, rowResult.choice);
      }

      diagnostics.push({
        qn,
        blockStart: block.startQ,
        rowRect: {
          x1: Number(optionsStartX.toFixed(1)),
          x2: Number((optionsStartX + optionsWidth).toFixed(1)),
          y1: Number(rowRect.y1.toFixed(1)),
          y2: Number(rowRect.y2.toFixed(1)),
        },
        ...rowResult,
      });
    }
  });

  return { answers, diagnostics, sectionInfo };
}

async function scanBuffer({ fileBuffer, keyMap, total = 35, lang = 'eng', includeDebug = false, calibration: calibrationInput = DEFAULT_CALIBRATION, rotation = 0, optionChoices = 'ABCDE' }) {
  let normalizedKeyMap = null;
  if (keyMap instanceof Map) {
    normalizedKeyMap = keyMap;
  } else if (keyMap && typeof keyMap === 'object') {
    normalizedKeyMap = new Map();
    Object.entries(keyMap).forEach(([k, v]) => {
      const qn = Number(k);
      if (Number.isFinite(qn) && qn > 0) {
        normalizedKeyMap.set(qn, String(v || '').trim().toUpperCase());
      }
    });
  }

  const normalizedOptionChoices = normalizeOptionChoices(optionChoices || calibrationInput?.optionChoices);
  const calibration = sanitizeCalibration(calibrationInput, total, normalizedOptionChoices);
  const safeRotation = sanitizeRotation(rotation);
  let gray = await toRawGray(fileBuffer, 1200, safeRotation);
  const initialStats = computeGrayStats(gray.data);
  const lowLightMode = isLowLightOrShadow(initialStats);
  if (lowLightMode) {
    gray = await toRawGrayEnhanced(fileBuffer, 1200, safeRotation);
  }

  const grayStats = computeGrayStats(gray.data);
  const adaptiveThreshold = deriveAdaptiveThreshold(grayStats);
    const layoutScan = detectAnswersFromSheetLayout(gray.data, gray.width, gray.height, total, calibration, normalizedOptionChoices, grayStats);
  const minimumDetectedForLayout = Math.max(8, Math.ceil(total * 0.35));
  let parsedFromLayout = layoutScan.answers;
  let ocrText = '';
  let parsedResult = { parsed: new Map(), duplicates: new Map(), missing: [] };
  let method = 'layout-grid';

  if (parsedFromLayout.size < minimumDetectedForLayout) {
    const preprocessed = await preprocessImage(fileBuffer, safeRotation, {
      threshold: adaptiveThreshold,
      lowLightMode,
    });
    ocrText = await runOcr(preprocessed, lang);
    parsedResult = parseAnswers(ocrText, total, normalizedOptionChoices);

    if (parsedResult.parsed.size >= parsedFromLayout.size) {
      parsedFromLayout = parsedResult.parsed;
      method = 'text-ocr';
    } else {
      parsedFromLayout = new Map();
      method = 'no-reliable-detection';
    }
  }

  const missing = buildMissing(parsedFromLayout, total);
  const score = normalizedKeyMap ? compareAnswers(parsedFromLayout, normalizedKeyMap) : null;
  let debug = null;

  if (includeDebug) {
    const grayPreview = await buildGrayPreview(gray.data, gray.width, gray.height);
    const sourcePreview = await buildSourcePreview(fileBuffer, gray.width, safeRotation);
    const processedPreview = await buildProcessedPreview(fileBuffer, gray.width, safeRotation);
    const overlayPreview = await buildDebugOverlay(grayPreview, layoutScan.diagnostics, gray.width, gray.height, 'standard');
    const heatmapPreview = await buildDebugOverlay(grayPreview, layoutScan.diagnostics, gray.width, gray.height, 'heatmap');

    debug = {
      width: gray.width,
      height: gray.height,
      imageStats: {
        mean: Number(grayStats.mean.toFixed(2)),
        stdDev: Number(grayStats.stdDev.toFixed(2)),
        darkRatio: Number(grayStats.darkRatio.toFixed(4)),
        brightRatio: Number(grayStats.brightRatio.toFixed(4)),
        lowLightMode,
        adaptiveThreshold,
      },
      sourceImage: asDataUrl(sourcePreview),
      grayImage: asDataUrl(grayPreview),
      processedImage: asDataUrl(processedPreview),
      overlayImage: asDataUrl(overlayPreview),
      heatmapImage: asDataUrl(heatmapPreview),
    };
  }

  return {
    method,
    rotation: safeRotation,
    rawText: ocrText,
    parsedAnswers: Object.fromEntries([...parsedFromLayout.entries()].sort((a, b) => a[0] - b[0])),
    duplicates: Object.fromEntries(parsedResult.duplicates.entries()),
    missing,
    diagnostics: layoutScan.diagnostics,
    sectionInfo: layoutScan.sectionInfo,
    debug,
    calibration,
    optionChoices: normalizedOptionChoices,
    answerKey: normalizedKeyMap ? Object.fromEntries([...normalizedKeyMap.entries()].sort((a, b) => a[0] - b[0])) : null,
    score,
  };
}

function generateAnswerKeyTemplate(totalQuestions = 35, optionChoices = 'ABCDE') {
  const normalizedChoices = normalizeOptionChoices(optionChoices);
  const template = {};
  for (let index = 1; index <= totalQuestions; index += 1) {
    template[index.toString()] = normalizedChoices[(index - 1) % normalizedChoices.length];
  }
  return template;
}

function parseAnswerKeyFromText(csvText, optionChoices = 'ABCDE') {
  const lines = String(csvText || '')
    .split('\n')
    .filter((line) => line.trim());
  const key = {};
  const optionPattern = getOptionLabels(optionChoices).join('');
  const optionRegex = new RegExp(`^[${optionPattern}]$`);

  lines.forEach((line) => {
    const parts = line.split(/[,|:\t]/).map((part) => part.trim());
    const qn = Number(parts[0]);
    const answer = String(parts[1] || '').toUpperCase();

    if (qn >= 1 && qn <= 1000 && optionRegex.test(answer)) {
      key[qn.toString()] = answer;
    }
  });

  return key;
}

function validateAnswerKey(keyObj, totalQuestions = 35, optionChoices = 'ABCDE') {
  const errors = [];
  const warnings = [];
  const optionPattern = getOptionLabels(optionChoices).join('');
  const optionRegex = new RegExp(`^[${optionPattern}]$`);

  for (let index = 1; index <= totalQuestions; index += 1) {
    const answer = keyObj[index.toString()];
    if (!answer) {
      errors.push(`Question ${index} missing answer`);
    } else if (!optionRegex.test(String(answer).toUpperCase())) {
      errors.push(`Question ${index} has invalid answer: ${answer}`);
    }
  }

  const extraKeys = Object.keys(keyObj).filter((key) => Number(key) > totalQuestions);
  if (extraKeys.length > 0) {
    warnings.push(`Extra questions beyond ${totalQuestions}: ${extraKeys.slice(0, 5).join(', ')}`);
  }

  return { valid: errors.length === 0, errors, warnings };
}

module.exports = {
  CALIBRATION_PRESETS,
  DEFAULT_CALIBRATION,
  getCalibrationPreset,
  normalizeOptionChoices,
  normalizeQuestionTotal,
  loadAnswerKey,
  sanitizeCalibration,
  sanitizeRotation,
  scanBuffer,
  generateAnswerKeyTemplate,
  parseAnswerKeyFromText,
  validateAnswerKey,
};
