const fs = require('fs');
const sharp = require('sharp');
const { createWorker } = require('tesseract.js');

const OPTION_LABELS = ['A', 'B', 'C', 'D', 'E'];
const DEFAULT_CALIBRATION = {
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
};

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

function sanitizeCalibration(input = {}) {
  const merged = cloneCalibration(DEFAULT_CALIBRATION);

  merged.markedThreshold = clampNumber(input.markedThreshold, 0, 255, merged.markedThreshold);
  merged.confidenceGap = clampNumber(input.confidenceGap, 0, 255, merged.confidenceGap);
  merged.questionColW = clampNumber(input.questionColW, 0.01, 0.5, merged.questionColW);
  merged.centerPadX = clampNumber(input.centerPadX, 0, 0.45, merged.centerPadX);
  merged.centerPadY = clampNumber(input.centerPadY, 0, 0.45, merged.centerPadY);

  if (Array.isArray(input.blocks)) {
    merged.blocks = merged.blocks.map((block, index) => {
      const source = input.blocks[index] || {};
      return {
        ...block,
        startQ: clampNumber(source.startQ, 1, 500, block.startQ),
        count: clampNumber(source.count, 1, 100, block.count),
        x: clampNumber(source.x, 0, 1, block.x),
        y: clampNumber(source.y, 0, 1, block.y),
        w: clampNumber(source.w, 0.01, 1, block.w),
        h: clampNumber(source.h, 0.01, 1, block.h),
        questionColW: clampNumber(source.questionColW, 0.01, 0.45, block.questionColW ?? merged.questionColW),
        rowTop: clampNumber(source.rowTop, 0, 0.9, block.rowTop ?? 0),
        rowBottom: clampNumber(source.rowBottom, 0.1, 1, block.rowBottom ?? 1),
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

async function preprocessImage(inputBuffer, rotation = 0) {
  return createNormalizedPipeline(inputBuffer, rotation)
    .grayscale()
    .normalize()
    .median(1)
    .threshold(165)
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

function parseAnswers(text, totalQuestions = 35) {
  const normalized = normalizeText(text);
  const pattern = /(?<!\d)(\d{1,2})\s*[.)-]?\s*([ABCDE])(?![A-Z])/g;
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

function detectChoiceInRow({ raw, width, rowRect, optionsStartX, optionsWidth, calibration }) {
  const colW = optionsWidth / OPTION_LABELS.length;
  const rowH = rowRect.y2 - rowRect.y1;
  const optionScores = OPTION_LABELS.map((label, index) => {
    const xCell1 = optionsStartX + index * colW;
    const xCell2 = xCell1 + colW;
    const centerPadX = colW * calibration.centerPadX;
    const centerPadY = rowH * calibration.centerPadY;
    const rect = {
      x1: xCell1 + centerPadX,
      y1: rowRect.y1 + centerPadY,
      x2: xCell2 - centerPadX,
      y2: rowRect.y2 - centerPadY,
    };
    const darkness = meanDarkness(raw, width, rect.x1, rect.y1, rect.x2, rect.y2);

    return { label, darkness, rect };
  });

  const ranked = [...optionScores].sort((a, b) => b.darkness - a.darkness);
  const marked = ranked[0];
  const second = ranked[1] || { darkness: 0 };
  const confidence = marked.darkness - second.darkness;
  const choice = marked.darkness > calibration.markedThreshold && confidence > calibration.confidenceGap ? marked.label : null;

  return {
    choice,
    method: 'find-marked',
    markedDarkness: Number(marked.darkness.toFixed(2)),
    confidence: Number(confidence.toFixed(2)),
    optionScores: optionScores.map((option) => ({
      label: option.label,
      darkness: Number(option.darkness.toFixed(2)),
      rect: {
        x1: Number(option.rect.x1.toFixed(1)),
        y1: Number(option.rect.y1.toFixed(1)),
        x2: Number(option.rect.x2.toFixed(1)),
        y2: Number(option.rect.y2.toFixed(1)),
      },
    })),
  };
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

function detectAnswersFromSheetLayout(raw, width, height, totalQuestions, calibration) {
  const answers = new Map();
  const diagnostics = [];

  calibration.blocks.forEach((block) => {
    const bx1 = block.x * width;
    const by1 = block.y * height;
    const bw = block.w * width;
    const bh = block.h * height;
    const questionColW = bw * (block.questionColW ?? calibration.questionColW);
    const optionsStartX = bx1 + questionColW;
    const optionsWidth = bw - questionColW;
    const rowTop = by1 + bh * (block.rowTop ?? 0);
    const rowBottom = by1 + bh * (block.rowBottom ?? 1);
    const usableHeight = Math.max(8, rowBottom - rowTop);

    for (let index = 0; index < block.count; index += 1) {
      const qn = block.startQ + index;
      if (qn > totalQuestions) {
        break;
      }

      const rowH = usableHeight / block.count;
      const rowRect = {
        y1: rowTop + index * rowH,
        y2: rowTop + (index + 1) * rowH,
      };

      const rowResult = detectChoiceInRow({
        raw,
        width,
        rowRect,
        optionsStartX,
        optionsWidth,
        calibration,
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

  return { answers, diagnostics };
}

async function scanBuffer({ fileBuffer, keyMap, total = 35, lang = 'eng', includeDebug = false, calibration: calibrationInput = DEFAULT_CALIBRATION, rotation = 0 }) {
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

  const calibration = sanitizeCalibration(calibrationInput);
  const safeRotation = sanitizeRotation(rotation);
  const gray = await toRawGray(fileBuffer, 1200, safeRotation);
  const layoutScan = detectAnswersFromSheetLayout(gray.data, gray.width, gray.height, total, calibration);
  const minimumDetectedForLayout = Math.max(8, Math.ceil(total * 0.35));
  let parsedFromLayout = layoutScan.answers;
  let ocrText = '';
  let parsedResult = { parsed: new Map(), duplicates: new Map(), missing: [] };
  let method = 'layout-grid';

  if (parsedFromLayout.size < minimumDetectedForLayout) {
    const preprocessed = await preprocessImage(fileBuffer, safeRotation);
    ocrText = await runOcr(preprocessed, lang);
    parsedResult = parseAnswers(ocrText, total);

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
    debug,
    calibration,
    answerKey: normalizedKeyMap ? Object.fromEntries([...normalizedKeyMap.entries()].sort((a, b) => a[0] - b[0])) : null,
    score,
  };
}

function generateAnswerKeyTemplate(totalQuestions = 35, optionChoices = 'ABCDE') {
  const template = {};
  for (let index = 1; index <= totalQuestions; index += 1) {
    template[index.toString()] = optionChoices[index % optionChoices.length];
  }
  return template;
}

function parseAnswerKeyFromText(csvText) {
  const lines = String(csvText || '')
    .split('\n')
    .filter((line) => line.trim());
  const key = {};

  lines.forEach((line) => {
    const parts = line.split(/[,|:\t]/).map((part) => part.trim());
    const qn = Number(parts[0]);
    const answer = String(parts[1] || '').toUpperCase();

    if (qn >= 1 && qn <= 1000 && /^[ABCDE]$/.test(answer)) {
      key[qn.toString()] = answer;
    }
  });

  return key;
}

function validateAnswerKey(keyObj, totalQuestions = 35) {
  const errors = [];
  const warnings = [];

  for (let index = 1; index <= totalQuestions; index += 1) {
    const answer = keyObj[index.toString()];
    if (!answer) {
      errors.push(`Question ${index} missing answer`);
    } else if (!/^[ABCDE]$/.test(String(answer).toUpperCase())) {
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
  DEFAULT_CALIBRATION,
  loadAnswerKey,
  sanitizeCalibration,
  sanitizeRotation,
  scanBuffer,
  generateAnswerKeyTemplate,
  parseAnswerKeyFromText,
  validateAnswerKey,
};
