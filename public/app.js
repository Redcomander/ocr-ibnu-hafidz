const PRESET_STORAGE_KEY = 'ocr-answer-reader-presets-v1';
const DEFAULT_PRESET_NAME = '__default__';
const THEME_STORAGE_KEY = 'ocr-answer-reader-theme';
const APP_CONFIG = window.OCR_APP_CONFIG || {};
const API_BASE_URL = String(APP_CONFIG.apiBaseUrl || '').trim().replace(/\/+$/, '');
const HARDWARE_SCANNER_API_BASE_URL = String(APP_CONFIG.hardwareScannerApiBaseUrl || '').trim().replace(/\/+$/, '');
const IMAGE_COMPRESSION_MAX_DIMENSION = 1800;
const IMAGE_COMPRESSION_QUALITY = 0.84;

const state = {
  calibration: null,
  presets: {},
  currentResult: null,
  corrections: {},
  overlayMode: 'overlay',
  previewRotation: 0,
  nudgeStep: 'fine',
  scanSourceFile: null,
  capabilities: null,
  hardwareScannerBaseUrl: null,
};

const dragState = {
  active: false,
  blockIndex: -1,
  mode: 'move',
  stage: null,
  startClientX: 0,
  startClientY: 0,
  sourceWidth: 1,
  sourceHeight: 1,
  stageWidth: 1,
  stageHeight: 1,
  startBlockPx: null,
  startSplitPx: 0,
  startRowTopPx: 0,
  startRowBottomPx: 0,
  selectedBlockIndex: 0,
  selectedMode: 'move',
  snapPx: 3,
};

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizeClientCalibration(calibration) {
  calibration.blocks = (calibration.blocks || []).map((block) => ({
    ...block,
    questionColW: Number.isFinite(Number(block.questionColW)) ? Number(block.questionColW) : calibration.questionColW,
    rowTop: Number.isFinite(Number(block.rowTop)) ? Number(block.rowTop) : 0,
    rowBottom: Number.isFinite(Number(block.rowBottom)) ? Number(block.rowBottom) : 1,
  }));
  return calibration;
}

function getPreferredTheme() {
  const saved = localStorage.getItem(THEME_STORAGE_KEY);
  if (saved === 'dark' || saved === 'light') {
    return saved;
  }

  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  const btn = document.getElementById('theme-toggle');
  if (btn) {
    btn.textContent = theme === 'dark' ? 'Light Mode' : 'Dark Mode';
  }
  localStorage.setItem(THEME_STORAGE_KEY, theme);
}

function getStoredPresets() {
  try {
    return JSON.parse(localStorage.getItem(PRESET_STORAGE_KEY) || '{}');
  } catch {
    return {};
  }
}

function saveStoredPresets() {
  localStorage.setItem(PRESET_STORAGE_KEY, JSON.stringify(state.presets));
}

async function postForm(url, formData) {
  const res = await fetch(buildApiUrl(url), {
    method: 'POST',
    body: formData,
  });

  const payload = await res.json();
  if (!res.ok) {
    throw new Error(payload.error || 'Request failed');
  }

  return payload;
}

function buildApiUrlFromBase(baseUrl, path) {
  if (/^https?:\/\//i.test(path)) {
    return path;
  }
  if (!baseUrl) {
    return path;
  }
  return `${baseUrl}${path}`;
}

function buildApiUrl(path) {
  return buildApiUrlFromBase(API_BASE_URL, path);
}

function getHardwareScannerApiBase() {
  if (state.hardwareScannerBaseUrl) {
    return state.hardwareScannerBaseUrl;
  }
  if (HARDWARE_SCANNER_API_BASE_URL) {
    return HARDWARE_SCANNER_API_BASE_URL;
  }
  return null;
}

function buildHardwareScannerApiUrl(path) {
  const base = getHardwareScannerApiBase();
  if (base) {
    return buildApiUrlFromBase(base, path);
  }
  return buildApiUrl(path);
}

function readImageFile(file) {
  return new Promise((resolve, reject) => {
    const objectUrl = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(objectUrl);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error(`Failed to read image: ${file.name}`));
    };
    image.src = objectUrl;
  });
}

function canvasToBlob(canvas, mimeType, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error('Image compression failed'));
        return;
      }
      resolve(blob);
    }, mimeType, quality);
  });
}

function applyBwEnhancement(context, width, height) {
  const imageData = context.getImageData(0, 0, width, height);
  const data = imageData.data;
  const histogram = new Array(256).fill(0);
  let pixelCount = 0;

  for (let index = 0; index < data.length; index += 4) {
    const r = data[index];
    const g = data[index + 1];
    const b = data[index + 2];
    const luminance = Math.max(0, Math.min(255, Math.round(0.2126 * r + 0.7152 * g + 0.0722 * b)));
    histogram[luminance] += 1;
    pixelCount += 1;
  }

  const percentileValue = (percentile) => {
    const target = pixelCount * percentile;
    let cumulative = 0;
    for (let value = 0; value < histogram.length; value += 1) {
      cumulative += histogram[value];
      if (cumulative >= target) {
        return value;
      }
    }
    return 255;
  };

  const low = percentileValue(0.04);
  const high = percentileValue(0.97);
  const range = Math.max(28, high - low);

  for (let index = 0; index < data.length; index += 4) {
    const r = data[index];
    const g = data[index + 1];
    const b = data[index + 2];
    const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const stretched = ((luminance - low) * 255) / range;
    const normalized = Math.max(0, Math.min(255, stretched));
    const gammaBoosted = 255 * Math.pow(normalized / 255, 0.92);
    const contrast = (gammaBoosted - 128) * 1.08 + 128;
    const enhanced = Math.max(0, Math.min(255, contrast));
    data[index] = enhanced;
    data[index + 1] = enhanced;
    data[index + 2] = enhanced;
  }

  context.putImageData(imageData, 0, 0);
}

async function optimizeImageForScan(file) {
  if (!(file instanceof File) || !file.type.startsWith('image/')) {
    return file;
  }

  try {
    const image = await readImageFile(file);
    const longestSide = Math.max(image.naturalWidth, image.naturalHeight);
    const scale = longestSide > IMAGE_COMPRESSION_MAX_DIMENSION ? IMAGE_COMPRESSION_MAX_DIMENSION / longestSide : 1;
    const targetWidth = Math.max(1, Math.round(image.naturalWidth * scale));
    const targetHeight = Math.max(1, Math.round(image.naturalHeight * scale));
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d', { alpha: false });

    if (!context) {
      return file;
    }

    canvas.width = targetWidth;
    canvas.height = targetHeight;
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, targetWidth, targetHeight);
    context.drawImage(image, 0, 0, targetWidth, targetHeight);
    applyBwEnhancement(context, targetWidth, targetHeight);

    const mimeType = 'image/jpeg';
    const blob = await canvasToBlob(canvas, mimeType, IMAGE_COMPRESSION_QUALITY);

    if (blob.size === 0) {
      return file;
    }

    const extension = '.jpg';
    const safeName = file.name.replace(/\.[^.]+$/, '') || 'upload';
    return new File([blob], `${safeName}${extension}`, {
      type: mimeType,
      lastModified: Date.now(),
    });
  } catch {
    return file;
  }
}

async function compressSelectedFiles(files, onProgress) {
  const items = [];
  for (let index = 0; index < files.length; index += 1) {
    const file = files[index];
    onProgress?.(index, files.length, file);
    items.push(await optimizeImageForScan(file));
  }
  return items;
}

function buildAnswerString(parsedAnswers) {
  return Object.entries(parsedAnswers || {})
    .map(([n, a]) => `${n}. ${a}`)
    .join(' | ');
}

function normalizeRotation(rotation) {
  const parsed = Number(rotation);
  if (!Number.isFinite(parsed)) {
    return 0;
  }
  return ((parsed % 360) + 360) % 360;
}

function getAppliedRotation(result) {
  return normalizeRotation(result?.rotation ?? 0);
}

function getPreviewRotation(result) {
  return normalizeRotation(state.previewRotation ?? getAppliedRotation(result));
}

function renderPreviewImage(src, alt, rotation) {
  const normalizedRotation = normalizeRotation(rotation);
  const quarterTurn = normalizedRotation % 180 !== 0;
  const classes = ['preview-frame'];
  if (quarterTurn) {
    classes.push('is-quarter-turn');
  }

  return `
    <div class="${classes.join(' ')}" style="--preview-rotation: ${normalizedRotation}deg;">
      <img class="debug-image preview-image" src="${src}" alt="${alt}" />
    </div>
  `;
}

function computeScore(parsedAnswers, answerKey) {
  if (!answerKey) {
    return null;
  }

  let correct = 0;
  let wrong = 0;
  const details = {};

  Object.entries(answerKey).forEach(([qn, expected]) => {
    const actual = parsedAnswers[qn] || null;
    const isCorrect = actual === expected;
    details[qn] = { expected, actual, correct: isCorrect };

    if (isCorrect) {
      correct += 1;
    } else {
      wrong += 1;
    }
  });

  const total = Object.keys(answerKey).length;
  return {
    correct,
    wrong,
    total,
    score: total ? (correct / total) * 100 : 0,
    details,
  };
}

function getEffectiveResult(result) {
  const parsedAnswers = { ...(result.parsedAnswers || {}) };
  Object.entries(state.corrections).forEach(([qn, value]) => {
    if (!value) {
      delete parsedAnswers[qn];
    } else {
      parsedAnswers[qn] = value;
    }
  });

  const sortedParsed = Object.fromEntries(
    Object.entries(parsedAnswers).sort((a, b) => Number(a[0]) - Number(b[0]))
  );

  return {
    ...result,
    parsedAnswers: sortedParsed,
    score: computeScore(sortedParsed, result.answerKey),
    rotation: getAppliedRotation(result),
    previewRotation: getPreviewRotation(result),
  };
}

function renderSingle(result) {
  const effective = getEffectiveResult(result);
  const answers = buildAnswerString(effective.parsedAnswers);
  const correctionCount = Object.keys(state.corrections).length;

  return `
    <p><strong>File:</strong> ${effective.fileName}</p>
    <p class="mini"><strong>Method:</strong> ${effective.method || 'unknown'}</p>
    ${
      effective.score
        ? `<div class="kpi">
            <div>Correct<br><span class="good">${effective.score.correct}</span></div>
            <div>Wrong<br><span class="bad">${effective.score.wrong}</span></div>
            <div>Score<br><strong>${effective.score.score.toFixed(2)}%</strong></div>
          </div>`
        : ''
    }
    <p class="mini"><strong>Detected Answers:</strong> ${answers || 'none'}</p>
    <p class="mini"><strong>Missing:</strong> ${(effective.missing || []).join(', ') || 'none'}</p>
    <p class="mini"><strong>Applied Rotation:</strong> ${effective.rotation}&deg;</p>
    <p class="mini"><strong>Preview Rotation:</strong> ${effective.previewRotation}&deg;</p>
    <p class="mini"><strong>Manual Corrections:</strong> ${correctionCount}</p>
  `;
}

function renderOptionScores(optionScores) {
  return (optionScores || [])
    .map((item) => `<span class="score-chip">${item.label}: ${item.darkness}</span>`)
    .join('');
}

function overlaySource(debug) {
  if (!debug) {
    return '';
  }

  if (state.overlayMode === 'gray') {
    return debug.grayImage;
  }
  if (state.overlayMode === 'processed') {
    return debug.processedImage;
  }
  if (state.overlayMode === 'heatmap') {
    return debug.heatmapImage;
  }
  return debug.overlayImage;
}

function renderOverlayButtons() {
  const items = [
    { key: 'overlay', label: 'Standard Overlay' },
    { key: 'heatmap', label: 'Heatmap Overlay' },
    { key: 'processed', label: 'Threshold View' },
    { key: 'gray', label: 'Gray View' },
  ];

  return `
    <div class="overlay-toggle">
      ${items
        .map(
          (item) =>
            `<button type="button" class="overlay-mode-btn ${state.overlayMode === item.key ? 'active' : ''}" data-overlay-mode="${item.key}">${item.label}</button>`
        )
        .join('')}
    </div>
  `;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function maybeSnap(value, event) {
  if (event?.altKey) {
    return value;
  }
  const step = dragState.snapPx || 1;
  return Math.round(value / step) * step;
}

function getStageAndSource() {
  const stage = document.getElementById('drag-stage');
  if (!stage) {
    return null;
  }

  return {
    stage,
    sourceWidth: Number(stage.dataset.sourceWidth || 1),
    sourceHeight: Number(stage.dataset.sourceHeight || 1),
  };
}

function getBlockPxFromCalibration(blockIndex, sourceWidth, sourceHeight) {
  const block = state.calibration.blocks[blockIndex];
  const x = block.x * sourceWidth;
  const y = block.y * sourceHeight;
  const w = block.w * sourceWidth;
  const h = block.h * sourceHeight;
  return {
    x,
    y,
    w,
    h,
    splitX: x + w * (block.questionColW ?? state.calibration.questionColW),
    rowTopY: y + h * (block.rowTop ?? 0),
    rowBottomY: y + h * (block.rowBottom ?? 1),
  };
}

function setSelectedTarget(blockIndex, mode) {
  dragState.selectedBlockIndex = blockIndex;
  dragState.selectedMode = mode;
}

function renderDragEditor(result) {
  const debug = result.debug;
  const width = Number(debug.width || 1);
  const height = Number(debug.height || 1);
  const compactViewport = window.matchMedia('(max-width: 900px)').matches;
  const resizeHandleRadius = compactViewport ? 14 : 7;
  const splitHandleRadius = compactViewport ? 12 : 7;
  const rowHandleRadius = compactViewport ? 11 : 6;
  const currentPreviewRotation = getPreviewRotation(result);
  const selectedMode = dragState.selectedMode || 'move';
  const selectedBlock = clamp(dragState.selectedBlockIndex ?? 0, 0, Math.max(0, (state.calibration?.blocks?.length || 1) - 1));
  const nudgeStepValue = state.nudgeStep === 'coarse' ? 10 : 3;
  const blockSelectorButtons = (state.calibration?.blocks || [])
    .map((block, index) => {
      const isActive = index === selectedBlock ? 'is-active' : '';
      return `<button type="button" class="secondary-btn adjust-btn block-chip ${isActive}" data-adjust-action="select-block" data-block-index="${index}">B${index + 1} (${block.startQ}-${block.startQ + block.count - 1})</button>`;
    })
    .join('');

  const blocks = (state.calibration?.blocks || []).map((block, index) => {
    const x = block.x * width;
    const y = block.y * height;
    const w = block.w * width;
    const h = block.h * height;
    const splitX = x + w * (block.questionColW ?? state.calibration.questionColW);
    const rowTopY = y + h * (block.rowTop ?? 0);
    const rowBottomY = y + h * (block.rowBottom ?? 1);
    const optionsW = Math.max(1, x + w - splitX);
    const colW = optionsW / 5;
    const rowH = Math.max(1, (rowBottomY - rowTopY) / Math.max(1, block.count));
    const endQ = block.startQ + block.count - 1;
    const selected = dragState.selectedBlockIndex === index ? 'is-selected' : '';

    const optionBoundaries = Array.from({ length: 6 }, (_, i) => {
      const px = splitX + i * colW;
      return `<line class="drag-col-guide" data-block-index="${index}" data-col-index="${i}" x1="${px}" y1="${rowTopY}" x2="${px}" y2="${rowBottomY}" />`;
    }).join('');

    const rowBoundaries = Array.from({ length: block.count + 1 }, (_, i) => {
      const py = rowTopY + i * rowH;
      return `<line class="drag-cell-row-guide" data-block-index="${index}" data-row-index="${i}" x1="${x}" y1="${py}" x2="${x + w}" y2="${py}" />`;
    }).join('');

    const optionLabels = ['A', 'B', 'C', 'D', 'E']
      .map((label, i) => {
        const lx = splitX + i * colW + colW * 0.5;
        const ly = Math.max(y + 14, rowTopY - 6);
        return `<text class="drag-col-label" data-block-index="${index}" data-col-index="${i}" x="${lx}" y="${ly}" text-anchor="middle">${label}</text>`;
      })
      .join('');

    const rowNumbers = Array.from({ length: block.count }, (_, rowIndex) => {
      const qn = block.startQ + rowIndex;
      const ny = rowTopY + rowH * rowIndex + rowH * 0.58;
      const nx = x + 4;
      return `<text class="drag-row-number" data-block-index="${index}" data-row-index="${rowIndex}" x="${nx}" y="${ny}">${qn}</text>`;
    }).join('');

    return `
      <g class="drag-block-group ${selected}" data-block-index="${index}">
        <rect class="drag-block" data-block-index="${index}" x="${x}" y="${y}" width="${w}" height="${h}" rx="4" />
        ${rowBoundaries}
        ${optionBoundaries}
        ${optionLabels}
        ${rowNumbers}
        <line class="drag-split" data-block-index="${index}" x1="${splitX}" y1="${y}" x2="${splitX}" y2="${y + h}" />
        <line class="drag-row-guide" data-guide="top" data-block-index="${index}" x1="${x}" y1="${rowTopY}" x2="${x + w}" y2="${rowTopY}" />
        <line class="drag-row-guide" data-guide="bottom" data-block-index="${index}" x1="${x}" y1="${rowBottomY}" x2="${x + w}" y2="${rowBottomY}" />
        <text class="drag-label" data-block-index="${index}" x="${x + 6}" y="${y + 16}">Block ${index + 1} (${block.startQ}-${endQ})</text>
        <circle class="drag-handle drag-resize-handle" data-block-index="${index}" cx="${x + w}" cy="${y + h}" r="${resizeHandleRadius}" />
        <circle class="drag-handle drag-split-handle" data-role="split" data-block-index="${index}" cx="${splitX}" cy="${y + h * 0.5}" r="${splitHandleRadius}" />
        <circle class="drag-handle drag-row-handle" data-role="rowTop" data-block-index="${index}" cx="${x + w - 10}" cy="${rowTopY}" r="${rowHandleRadius}" />
        <circle class="drag-handle drag-row-handle" data-role="rowBottom" data-block-index="${index}" cx="${x + w - 10}" cy="${rowBottomY}" r="${rowHandleRadius}" />
      </g>
    `;
  });

  return `
    <section class="debug-card">
      <h3>Drag-and-Drop Calibration</h3>
      <p class="mini">Drag rectangle: move block. Corner handle: resize. Vertical handle: split question/options. Horizontal handles: top and bottom row guides. On mobile, use the control pad below for more precise adjustment.</p>
      <div class="drag-actions">
        <div class="rotate-actions">
          <button type="button" id="btn-rotate-left" class="secondary-btn">Rotate -90&deg;</button>
          <button type="button" id="btn-rotate-reset" class="secondary-btn">Reset Rotation</button>
          <button type="button" id="btn-rotate-right" class="secondary-btn">Rotate +90&deg;</button>
          <span class="rotation-pill">Preview: ${currentPreviewRotation}&deg; | Applied: ${getAppliedRotation(result)}&deg;</span>
        </div>
        <div class="mobile-adjust-panel">
          <div class="adjust-header">
            <span class="rotation-pill">Block ${selectedBlock + 1} | Step ${nudgeStepValue}px</span>
            <div class="adjust-block-switch">
              <button type="button" class="secondary-btn adjust-btn" data-adjust-action="prev-block">Prev Block</button>
              <button type="button" class="secondary-btn adjust-btn" data-adjust-action="next-block">Next Block</button>
            </div>
          </div>
          <div class="block-selector-strip">
            ${blockSelectorButtons}
          </div>
          <div class="adjust-step-row">
            <button type="button" class="secondary-btn adjust-btn ${state.nudgeStep === 'fine' ? 'is-active' : ''}" data-adjust-action="set-step" data-step="fine">Fine</button>
            <button type="button" class="secondary-btn adjust-btn ${state.nudgeStep === 'coarse' ? 'is-active' : ''}" data-adjust-action="set-step" data-step="coarse">Coarse</button>
          </div>
          <div class="adjust-mode-row">
            ${[
              ['move', 'Move'],
              ['resize', 'Resize'],
              ['split', 'Split'],
              ['rowTop', 'Row Top'],
              ['rowBottom', 'Row Bottom'],
            ]
              .map(
                ([mode, label]) =>
                  `<button type="button" class="secondary-btn adjust-btn ${selectedMode === mode ? 'is-active' : ''}" data-adjust-action="set-mode" data-mode="${mode}">${label}</button>`
              )
              .join('')}
          </div>
          <div class="adjust-step-row">
            <button type="button" class="secondary-btn adjust-btn" data-adjust-action="resize-quick" data-resize-dx="-1" data-resize-dy="0">Width -</button>
            <button type="button" class="secondary-btn adjust-btn" data-adjust-action="resize-quick" data-resize-dx="1" data-resize-dy="0">Width +</button>
            <button type="button" class="secondary-btn adjust-btn" data-adjust-action="resize-quick" data-resize-dx="0" data-resize-dy="-1">Height -</button>
            <button type="button" class="secondary-btn adjust-btn" data-adjust-action="resize-quick" data-resize-dx="0" data-resize-dy="1">Height +</button>
          </div>
          <div class="adjust-pad">
            <button type="button" class="secondary-btn adjust-btn" data-adjust-action="nudge" data-dx="0" data-dy="-1">Up</button>
            <button type="button" class="secondary-btn adjust-btn" data-adjust-action="nudge" data-dx="-1" data-dy="0">Left</button>
            <button type="button" class="secondary-btn adjust-btn" data-adjust-action="nudge" data-dx="1" data-dy="0">Right</button>
            <button type="button" class="secondary-btn adjust-btn" data-adjust-action="nudge" data-dx="0" data-dy="1">Down</button>
          </div>
        </div>
        <button type="button" id="btn-apply-rescan" class="secondary-btn">Apply &amp; Rescan</button>
      </div>
      <div class="drag-stage" id="drag-stage" tabindex="0" data-source-width="${width}" data-source-height="${height}">
        <img class="debug-image" src="${debug.grayImage}" alt="Calibration base image" />
        <svg class="drag-svg" viewBox="0 0 ${width} ${height}" preserveAspectRatio="xMidYMid meet">
          ${blocks.join('')}
        </svg>
      </div>
    </section>
  `;
}

function renderDiagnostics(result) {
  if (!result.debug) {
    return '<p class="mini">Debug view was disabled for this scan.</p>';
  }

  const effective = getEffectiveResult(result);
  const previewRotation = getPreviewRotation(result);
  const rows = (result.diagnostics || [])
    .map((row) => {
      const expected = result.answerKey?.[String(row.qn)] || '-';
      const corrected = state.corrections[String(row.qn)] || '';
      const actual = effective.parsedAnswers[String(row.qn)] || '-';
      const detail = effective.score?.details?.[String(row.qn)] || null;
      const verdict = detail ? (detail.correct ? '<span class="good">OK</span>' : '<span class="bad">Wrong</span>') : '-';

      return `
        <tr>
          <td>${row.qn}</td>
          <td>${row.choice || '-'}</td>
          <td>${expected}</td>
          <td>${actual}</td>
          <td>
            <select class="correction-select" data-qn="${row.qn}">
              <option value="">Use model</option>
              ${['A', 'B', 'C', 'D', 'E']
                .map((label) => `<option value="${label}" ${corrected === label ? 'selected' : ''}>${label}</option>`)
                .join('')}
            </select>
          </td>
          <td>${row.markedDarkness ?? '-'}</td>
          <td>${row.confidence ?? '-'}</td>
          <td>${verdict}</td>
          <td>${renderOptionScores(row.optionScores)}</td>
        </tr>
      `;
    })
    .join('');

  return `
    ${renderOverlayButtons()}
    ${renderDragEditor(result)}
    <section class="debug-card">
      <h3>Active Overlay</h3>
      ${renderPreviewImage(overlaySource(result.debug), 'OCR overlay preview', previewRotation)}
    </section>
    <div class="debug-grid">
      <section class="debug-card">
        <h3>Gray Preview</h3>
        ${renderPreviewImage(result.debug.grayImage, 'Gray preview', previewRotation)}
      </section>
      <section class="debug-card">
        <h3>Processed Threshold Preview</h3>
        ${renderPreviewImage(result.debug.processedImage, 'Processed preview', previewRotation)}
      </section>
    </div>
    <section class="debug-card">
      <h3>Per-Question Diagnostics</h3>
        <div class="table-scroll">
          <table class="diagnostics-table">
            <thead>
              <tr>
                <th>Q</th>
                <th>Model</th>
                <th>Expected</th>
                <th>Effective</th>
                <th>Correct</th>
                <th>Darkness</th>
                <th>Confidence</th>
                <th>Status</th>
                <th>Option Scores</th>
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
    </section>
  `;
}

function renderBulkTable(items) {
  const rows = items
    .map((item) => {
      const score = item.score || { correct: 0, wrong: 0, score: 0 };
      return `
        <tr>
          <td>${item.fileName}</td>
          <td>${item.method || 'unknown'}</td>
          <td class="good">${score.correct}</td>
          <td class="bad">${score.wrong}</td>
          <td>${score.score.toFixed(2)}%</td>
          <td>${Object.keys(item.parsedAnswers || {}).length}</td>
        </tr>
      `;
    })
    .join('');

  return `
    <div class="table-scroll">
      <table class="table">
        <thead>
          <tr>
            <th>File</th>
            <th>Method</th>
            <th>Right</th>
            <th>Wrong</th>
            <th>Score</th>
            <th>Detected</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  `;
}

function getFieldDefinitions() {
  return {
    global: [
      { key: 'markedThreshold', label: 'Marked Threshold', step: '0.5' },
      { key: 'confidenceGap', label: 'Confidence Gap', step: '0.1' },
      { key: 'questionColW', label: 'Question Col W', step: '0.01' },
      { key: 'centerPadX', label: 'Center Pad X', step: '0.01' },
      { key: 'centerPadY', label: 'Center Pad Y', step: '0.01' },
    ],
    block: [
      { key: 'x', label: 'X', step: '0.005' },
      { key: 'y', label: 'Y', step: '0.005' },
      { key: 'w', label: 'Width', step: '0.005' },
      { key: 'h', label: 'Height', step: '0.005' },
      { key: 'questionColW', label: 'Question Col W', step: '0.01' },
      { key: 'rowTop', label: 'Row Top', step: '0.01' },
      { key: 'rowBottom', label: 'Row Bottom', step: '0.01' },
      { key: 'count', label: 'Rows', step: '1' },
    ],
  };
}

function renderCalibrationForm() {
  const defs = getFieldDefinitions();
  const globalFields = defs.global
    .map(
      (field) => `
        <label>
          ${field.label}
          <input type="number" step="${field.step}" data-scope="global" data-key="${field.key}" value="${state.calibration[field.key]}" />
        </label>
      `
    )
    .join('');

  const blockSections = state.calibration.blocks
    .map(
      (block, index) => `
        <section class="calibration-section">
          <h3>Block ${index + 1} (${block.startQ}-${block.startQ + block.count - 1})</h3>
          <div class="calibration-grid">
            <label>
              Start Q
              <input type="number" step="1" data-scope="block" data-index="${index}" data-key="startQ" value="${block.startQ}" />
            </label>
            ${defs.block
              .map(
                (field) => `
                  <label>
                    ${field.label}
                    <input type="number" step="${field.step}" data-scope="block" data-index="${index}" data-key="${field.key}" value="${block[field.key] ?? ''}" />
                  </label>
                `
              )
              .join('')}
          </div>
        </section>
      `
    )
    .join('');

  document.getElementById('calibration-form').innerHTML = `
    <section class="calibration-section">
      <h3>Global Calibration</h3>
      <div class="calibration-grid">${globalFields}</div>
    </section>
    ${blockSections}
  `;
}

function syncBlockVisual(stage, index, blockPx) {
  const block = state.calibration?.blocks?.[index];
  if (!block) {
    return;
  }
  const rect = stage.querySelector(`.drag-block[data-block-index="${index}"]`);
  const resizeHandle = stage.querySelector(`.drag-resize-handle[data-block-index="${index}"]`);
  const splitLine = stage.querySelector(`.drag-split[data-block-index="${index}"]`);
  const rowTopLine = stage.querySelector(`.drag-row-guide[data-guide="top"][data-block-index="${index}"]`);
  const rowBottomLine = stage.querySelector(`.drag-row-guide[data-guide="bottom"][data-block-index="${index}"]`);
  const splitHandle = stage.querySelector(`.drag-split-handle[data-block-index="${index}"]`);
  const rowTopHandle = stage.querySelector(`.drag-row-handle[data-role="rowTop"][data-block-index="${index}"]`);
  const rowBottomHandle = stage.querySelector(`.drag-row-handle[data-role="rowBottom"][data-block-index="${index}"]`);
  const label = stage.querySelector(`.drag-label[data-block-index="${index}"]`);
  if (!rect || !resizeHandle || !splitLine || !rowTopLine || !rowBottomLine || !splitHandle || !rowTopHandle || !rowBottomHandle) {
    return;
  }

  rect.setAttribute('x', String(blockPx.x));
  rect.setAttribute('y', String(blockPx.y));
  rect.setAttribute('width', String(blockPx.w));
  rect.setAttribute('height', String(blockPx.h));
  resizeHandle.setAttribute('cx', String(blockPx.x + blockPx.w));
  resizeHandle.setAttribute('cy', String(blockPx.y + blockPx.h));

  splitLine.setAttribute('x1', String(blockPx.splitX));
  splitLine.setAttribute('x2', String(blockPx.splitX));
  splitLine.setAttribute('y1', String(blockPx.y));
  splitLine.setAttribute('y2', String(blockPx.y + blockPx.h));
  splitHandle.setAttribute('cx', String(blockPx.splitX));
  splitHandle.setAttribute('cy', String(blockPx.y + blockPx.h * 0.5));

  rowTopLine.setAttribute('x1', String(blockPx.x));
  rowTopLine.setAttribute('x2', String(blockPx.x + blockPx.w));
  rowTopLine.setAttribute('y1', String(blockPx.rowTopY));
  rowTopLine.setAttribute('y2', String(blockPx.rowTopY));
  rowTopHandle.setAttribute('cx', String(blockPx.x + blockPx.w - 10));
  rowTopHandle.setAttribute('cy', String(blockPx.rowTopY));

  rowBottomLine.setAttribute('x1', String(blockPx.x));
  rowBottomLine.setAttribute('x2', String(blockPx.x + blockPx.w));
  rowBottomLine.setAttribute('y1', String(blockPx.rowBottomY));
  rowBottomLine.setAttribute('y2', String(blockPx.rowBottomY));
  rowBottomHandle.setAttribute('cx', String(blockPx.x + blockPx.w - 10));
  rowBottomHandle.setAttribute('cy', String(blockPx.rowBottomY));

  if (label) {
    label.setAttribute('x', String(blockPx.x + 6));
    label.setAttribute('y', String(blockPx.y + 16));
  }

  const rowSpan = Math.max(1, blockPx.rowBottomY - blockPx.rowTopY);
  const rowH = rowSpan / Math.max(1, block.count);
  const optionW = Math.max(1, blockPx.x + blockPx.w - blockPx.splitX);
  const colW = optionW / 5;

  stage.querySelectorAll(`.drag-col-guide[data-block-index="${index}"]`).forEach((guide) => {
    const colIndex = Number(guide.dataset.colIndex || 0);
    const px = blockPx.splitX + colW * colIndex;
    guide.setAttribute('x1', String(px));
    guide.setAttribute('x2', String(px));
    guide.setAttribute('y1', String(blockPx.rowTopY));
    guide.setAttribute('y2', String(blockPx.rowBottomY));
  });

  stage.querySelectorAll(`.drag-cell-row-guide[data-block-index="${index}"]`).forEach((guide) => {
    const rowIndex = Number(guide.dataset.rowIndex || 0);
    const py = blockPx.rowTopY + rowH * rowIndex;
    guide.setAttribute('x1', String(blockPx.x));
    guide.setAttribute('x2', String(blockPx.x + blockPx.w));
    guide.setAttribute('y1', String(py));
    guide.setAttribute('y2', String(py));
  });

  stage.querySelectorAll(`.drag-col-label[data-block-index="${index}"]`).forEach((labelEl) => {
    const colIndex = Number(labelEl.dataset.colIndex || 0);
    const lx = blockPx.splitX + colW * colIndex + colW * 0.5;
    const ly = Math.max(blockPx.y + 14, blockPx.rowTopY - 6);
    labelEl.setAttribute('x', String(lx));
    labelEl.setAttribute('y', String(ly));
  });

  stage.querySelectorAll(`.drag-row-number[data-block-index="${index}"]`).forEach((numEl) => {
    const rowIndex = Number(numEl.dataset.rowIndex || 0);
    const qn = block.startQ + rowIndex;
    const ny = blockPx.rowTopY + rowH * rowIndex + rowH * 0.58;
    numEl.textContent = String(qn);
    numEl.setAttribute('x', String(blockPx.x + 4));
    numEl.setAttribute('y', String(ny));
  });
}

function applyDraggedBlock(blockIndex, blockPx) {
  const b = state.calibration.blocks[blockIndex];
  b.x = Number((blockPx.x / dragState.sourceWidth).toFixed(4));
  b.y = Number((blockPx.y / dragState.sourceHeight).toFixed(4));
  b.w = Number((blockPx.w / dragState.sourceWidth).toFixed(4));
  b.h = Number((blockPx.h / dragState.sourceHeight).toFixed(4));
  b.questionColW = Number(((blockPx.splitX - blockPx.x) / Math.max(1, blockPx.w)).toFixed(4));
  b.rowTop = Number(((blockPx.rowTopY - blockPx.y) / Math.max(1, blockPx.h)).toFixed(4));
  b.rowBottom = Number(((blockPx.rowBottomY - blockPx.y) / Math.max(1, blockPx.h)).toFixed(4));
}

function startDrag(event, mode, blockIndex, stage) {
  const sourceWidth = Number(stage.dataset.sourceWidth || 1);
  const sourceHeight = Number(stage.dataset.sourceHeight || 1);
  const stageRect = stage.getBoundingClientRect();
  const block = state.calibration.blocks[blockIndex];

  dragState.active = true;
  dragState.mode = mode;
  dragState.blockIndex = blockIndex;
  dragState.stage = stage;
  dragState.startClientX = event.clientX;
  dragState.startClientY = event.clientY;
  dragState.sourceWidth = sourceWidth;
  dragState.sourceHeight = sourceHeight;
  dragState.stageWidth = stageRect.width;
  dragState.stageHeight = stageRect.height;
  dragState.startBlockPx = {
    x: block.x * sourceWidth,
    y: block.y * sourceHeight,
    w: block.w * sourceWidth,
    h: block.h * sourceHeight,
    splitX: block.x * sourceWidth + block.w * sourceWidth * (block.questionColW ?? state.calibration.questionColW),
    rowTopY: block.y * sourceHeight + block.h * sourceHeight * (block.rowTop ?? 0),
    rowBottomY: block.y * sourceHeight + block.h * sourceHeight * (block.rowBottom ?? 1),
  };
  dragState.startSplitPx = dragState.startBlockPx.splitX;
  dragState.startRowTopPx = dragState.startBlockPx.rowTopY;
  dragState.startRowBottomPx = dragState.startBlockPx.rowBottomY;
  setSelectedTarget(blockIndex, mode);
}

function onDragMove(event) {
  if (!dragState.active || !dragState.stage || !dragState.startBlockPx) {
    return;
  }

  const dxSource = ((event.clientX - dragState.startClientX) / dragState.stageWidth) * dragState.sourceWidth;
  const dySource = ((event.clientY - dragState.startClientY) / dragState.stageHeight) * dragState.sourceHeight;
  const blockPx = { ...dragState.startBlockPx };

  if (dragState.mode === 'move') {
    blockPx.x = maybeSnap(clamp(blockPx.x + dxSource, 0, dragState.sourceWidth - blockPx.w), event);
    blockPx.y = maybeSnap(clamp(blockPx.y + dySource, 0, dragState.sourceHeight - blockPx.h), event);
    const splitRatio = (dragState.startSplitPx - dragState.startBlockPx.x) / Math.max(1, dragState.startBlockPx.w);
    const rowTopRatio = (dragState.startRowTopPx - dragState.startBlockPx.y) / Math.max(1, dragState.startBlockPx.h);
    const rowBottomRatio = (dragState.startRowBottomPx - dragState.startBlockPx.y) / Math.max(1, dragState.startBlockPx.h);
    blockPx.splitX = blockPx.x + blockPx.w * splitRatio;
    blockPx.rowTopY = blockPx.y + blockPx.h * rowTopRatio;
    blockPx.rowBottomY = blockPx.y + blockPx.h * rowBottomRatio;
  } else if (dragState.mode === 'resize') {
    blockPx.w = maybeSnap(clamp(blockPx.w + dxSource, 24, dragState.sourceWidth - blockPx.x), event);
    blockPx.h = maybeSnap(clamp(blockPx.h + dySource, 24, dragState.sourceHeight - blockPx.y), event);
    const splitRatio = (dragState.startSplitPx - dragState.startBlockPx.x) / Math.max(1, dragState.startBlockPx.w);
    const rowTopRatio = (dragState.startRowTopPx - dragState.startBlockPx.y) / Math.max(1, dragState.startBlockPx.h);
    const rowBottomRatio = (dragState.startRowBottomPx - dragState.startBlockPx.y) / Math.max(1, dragState.startBlockPx.h);
    blockPx.splitX = blockPx.x + blockPx.w * splitRatio;
    blockPx.rowTopY = blockPx.y + blockPx.h * rowTopRatio;
    blockPx.rowBottomY = blockPx.y + blockPx.h * rowBottomRatio;
  } else if (dragState.mode === 'split') {
    blockPx.splitX = maybeSnap(clamp(dragState.startSplitPx + dxSource, blockPx.x + blockPx.w * 0.03, blockPx.x + blockPx.w * 0.45), event);
    blockPx.rowTopY = dragState.startRowTopPx;
    blockPx.rowBottomY = dragState.startRowBottomPx;
  } else if (dragState.mode === 'rowTop') {
    blockPx.splitX = dragState.startSplitPx;
    blockPx.rowTopY = maybeSnap(clamp(dragState.startRowTopPx + dySource, blockPx.y, dragState.startRowBottomPx - blockPx.h * 0.05), event);
    blockPx.rowBottomY = dragState.startRowBottomPx;
  } else {
    blockPx.splitX = dragState.startSplitPx;
    blockPx.rowTopY = dragState.startRowTopPx;
    blockPx.rowBottomY = maybeSnap(clamp(dragState.startRowBottomPx + dySource, dragState.startRowTopPx + blockPx.h * 0.05, blockPx.y + blockPx.h), event);
  }

  syncBlockVisual(dragState.stage, dragState.blockIndex, blockPx);
  applyDraggedBlock(dragState.blockIndex, blockPx);
}

function stopDrag() {
  if (!dragState.active) {
    return;
  }

  dragState.active = false;
  dragState.stage = null;
  dragState.startBlockPx = null;
  renderCalibrationForm();
}

function applySelectedTargetNudge(dx, dy, options = {}) {
  if (!state.currentResult || !state.calibration) {
    return false;
  }

  const stageInfo = getStageAndSource();
  if (!stageInfo) {
    return false;
  }

  const { stage, sourceWidth, sourceHeight } = stageInfo;
  const blockIndex = clamp(dragState.selectedBlockIndex ?? 0, 0, state.calibration.blocks.length - 1);
  const mode = dragState.selectedMode || 'move';
  const original = getBlockPxFromCalibration(blockIndex, sourceWidth, sourceHeight);
  const blockPx = { ...original };
  const syntheticEvent = options.disableSnap ? { altKey: true } : null;

  if (mode === 'move') {
    blockPx.x = maybeSnap(clamp(blockPx.x + dx, 0, sourceWidth - blockPx.w), syntheticEvent);
    blockPx.y = maybeSnap(clamp(blockPx.y + dy, 0, sourceHeight - blockPx.h), syntheticEvent);
    const splitRatio = (original.splitX - original.x) / Math.max(1, original.w);
    const topRatio = (original.rowTopY - original.y) / Math.max(1, original.h);
    const bottomRatio = (original.rowBottomY - original.y) / Math.max(1, original.h);
    blockPx.splitX = blockPx.x + blockPx.w * splitRatio;
    blockPx.rowTopY = blockPx.y + blockPx.h * topRatio;
    blockPx.rowBottomY = blockPx.y + blockPx.h * bottomRatio;
  } else if (mode === 'resize') {
    blockPx.w = maybeSnap(clamp(blockPx.w + dx, 24, sourceWidth - blockPx.x), syntheticEvent);
    blockPx.h = maybeSnap(clamp(blockPx.h + dy, 24, sourceHeight - blockPx.y), syntheticEvent);
  } else if (mode === 'split') {
    blockPx.splitX = maybeSnap(clamp(blockPx.splitX + dx, blockPx.x + blockPx.w * 0.03, blockPx.x + blockPx.w * 0.45), syntheticEvent);
  } else if (mode === 'rowTop') {
    blockPx.rowTopY = maybeSnap(clamp(blockPx.rowTopY + dy, blockPx.y, blockPx.rowBottomY - blockPx.h * 0.05), syntheticEvent);
  } else if (mode === 'rowBottom') {
    blockPx.rowBottomY = maybeSnap(clamp(blockPx.rowBottomY + dy, blockPx.rowTopY + blockPx.h * 0.05, blockPx.y + blockPx.h), syntheticEvent);
  }

  syncBlockVisual(stage, blockIndex, blockPx);
  dragState.sourceWidth = sourceWidth;
  dragState.sourceHeight = sourceHeight;
  applyDraggedBlock(blockIndex, blockPx);
  renderCalibrationForm();
  return true;
}

function nudgeSelectedTarget(event) {
  const arrowKeys = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'];
  if (!arrowKeys.includes(event.key)) {
    return;
  }
  const step = event.shiftKey ? 6 : 2;
  const dx = event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0;
  const dy = event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0;
  if (applySelectedTargetNudge(dx, dy, { disableSnap: event.altKey })) {
    event.preventDefault();
  }
}

function updatePresetSelect() {
  const presetSelect = document.getElementById('preset-select');
  const names = [DEFAULT_PRESET_NAME, ...Object.keys(state.presets).sort()];
  presetSelect.innerHTML = names
    .map((name) => `<option value="${name}">${name === DEFAULT_PRESET_NAME ? 'Default' : name}</option>`)
    .join('');
}

function applyPreset(name) {
  if (name === DEFAULT_PRESET_NAME) {
    loadDefaultCalibration(true);
    return;
  }

  if (!state.presets[name]) {
    return;
  }

  state.calibration = deepClone(state.presets[name]);
  normalizeClientCalibration(state.calibration);
  renderCalibrationForm();
  document.getElementById('calibration-output').innerHTML = `<p class="good">Loaded preset: ${name}</p>`;
}

async function loadDefaultCalibration(silent = false) {
  const res = await fetch(buildApiUrl('/api/calibration/default'));
  const data = await res.json();
  state.calibration = deepClone(data.calibration);
  normalizeClientCalibration(state.calibration);
  renderCalibrationForm();
  if (!silent) {
    document.getElementById('calibration-output').innerHTML = '<p class="good">Calibration reset to default.</p>';
  }
}

async function loadKeyStatus() {
  try {
    const res = await fetch(buildApiUrl('/api/answer-key/current'));
    const data = await res.json();
    const statusEl = document.getElementById('key-status');

    if (data.loaded) {
      statusEl.innerHTML = `
        <strong>✓ Answer Key Loaded</strong><br>
        <small>Questions: ${data.count} | Preview: ${Object.values(data.preview).join(', ')}</small>
      `;
      statusEl.className = 'key-status status-good';
    } else {
      statusEl.innerHTML = '<strong>No Answer Key</strong><br><small>Upload one or download template to get started</small>';
      statusEl.className = 'key-status status-warn';
    }
  } catch {
    const statusEl = document.getElementById('key-status');
    statusEl.className = 'key-status status-bad';
    statusEl.innerHTML = '<p class="bad">Error loading key status</p>';
  }
}

async function loadCapabilities() {
  const candidates = [];
  const pushCandidate = (value) => {
    const normalized = String(value || '').trim().replace(/\/+$/, '');
    if (!normalized) {
      return;
    }
    if (!candidates.includes(normalized)) {
      candidates.push(normalized);
    }
  };

  pushCandidate(HARDWARE_SCANNER_API_BASE_URL);
  pushCandidate(API_BASE_URL);
  pushCandidate(window.location.origin);
  pushCandidate('http://localhost:3099');

  let firstResponse = null;
  state.hardwareScannerBaseUrl = null;
  state.capabilities = null;

  for (const baseUrl of candidates) {
    try {
      const res = await fetch(buildApiUrlFromBase(baseUrl, '/api/capabilities'));
      if (!res.ok) {
        continue;
      }
      const data = await res.json();
      if (!firstResponse) {
        firstResponse = data;
      }
      if (data?.hardwareScanner?.supported) {
        state.capabilities = data;
        state.hardwareScannerBaseUrl = baseUrl;
        break;
      }
    } catch {
      // Try next candidate base URL.
    }
  }

  if (!state.capabilities) {
    state.capabilities = firstResponse;
  }

  const supported = Boolean(state.capabilities?.hardwareScanner?.supported);
  if (btnHardwareScan) {
    btnHardwareScan.disabled = !supported;
    if (!supported) {
      const reason = state.capabilities?.hardwareScanner?.reason || 'Hardware scanner is unavailable on this host. Run local API on Windows to use desktop scanner.';
      btnHardwareScan.title = reason;
      btnHardwareScan.textContent = 'Hardware Scanner Unavailable On This Server';
    } else {
      btnHardwareScan.title = '';
      btnHardwareScan.textContent = 'Scan From Hardware Scanner (Desktop)';
    }
  }
}

const singleForm = document.getElementById('single-form');
const bulkForm = document.getElementById('bulk-form');
const singleOutput = document.getElementById('single-output');
const singleDebug = document.getElementById('single-debug');
const bulkSummary = document.getElementById('bulk-summary');
const bulkOutput = document.getElementById('bulk-output');
const btnDownloadTemplate = document.getElementById('btn-download-template');
const btnUploadKey = document.getElementById('btn-upload-key');
const keyFileInput = document.getElementById('key-file-input');
const keyOutput = document.getElementById('key-output');
const presetSelect = document.getElementById('preset-select');
const presetNameInput = document.getElementById('preset-name');
const calibrationOutput = document.getElementById('calibration-output');
const themeToggle = document.getElementById('theme-toggle');
const singleFileInput = singleForm.querySelector('input[name="file"]');
const bulkFileInput = bulkForm.querySelector('input[name="files"]');
const btnOpenScanner = document.getElementById('btn-open-scanner');
const btnHardwareScan = document.getElementById('btn-hardware-scan');
const scannerPanel = document.getElementById('scanner-panel');
const scannerVideo = document.getElementById('scanner-video');
const scannerCanvas = document.getElementById('scanner-canvas');
const btnCaptureScan = document.getElementById('btn-capture-scan');
const btnCloseScanner = document.getElementById('btn-close-scanner');
const scannerStatus = document.getElementById('scanner-status');

let scannerStream = null;

function getSingleSourceFile() {
  return state.scanSourceFile || singleFileInput.files?.[0] || null;
}

function hasSingleSourceFile() {
  return Boolean(getSingleSourceFile());
}

async function startScanner() {
  if (!navigator.mediaDevices?.getUserMedia) {
    scannerStatus.textContent = 'Camera scanner is not supported on this browser/device.';
    scannerPanel.classList.remove('hidden');
    return;
  }

  try {
    scannerStream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: 'environment' },
      },
      audio: false,
    });
    scannerVideo.srcObject = scannerStream;
    scannerPanel.classList.remove('hidden');
    scannerStatus.textContent = 'Camera ready. Position the sheet and tap Capture Scan.';
  } catch (error) {
    scannerPanel.classList.remove('hidden');
    scannerStatus.textContent = `Unable to open camera: ${error.message || 'permission denied'}`;
  }
}

function stopScanner() {
  if (scannerStream) {
    scannerStream.getTracks().forEach((track) => track.stop());
    scannerStream = null;
  }
  scannerVideo.srcObject = null;
}

async function captureScannerImage() {
  if (!scannerVideo.videoWidth || !scannerVideo.videoHeight) {
    throw new Error('Camera is not ready yet.');
  }

  scannerCanvas.width = scannerVideo.videoWidth;
  scannerCanvas.height = scannerVideo.videoHeight;
  const context = scannerCanvas.getContext('2d', { alpha: false });
  if (!context) {
    throw new Error('Unable to capture camera frame.');
  }

  context.drawImage(scannerVideo, 0, 0, scannerCanvas.width, scannerCanvas.height);
  const blob = await canvasToBlob(scannerCanvas, 'image/jpeg', 0.9);
  if (!blob || blob.size === 0) {
    throw new Error('Captured frame is empty.');
  }

  state.scanSourceFile = new File([blob], `scanner_capture_${Date.now()}.jpg`, {
    type: 'image/jpeg',
    lastModified: Date.now(),
  });
  state.previewRotation = 0;
}

function buildSingleScanFormData() {
  const sourceFile = getSingleSourceFile();
  if (!sourceFile) {
    throw new Error('Please select an image file or capture one with the scanner first.');
  }

  return optimizeImageForScan(sourceFile).then((optimizedFile) => {
    const formData = new FormData(singleForm);
    formData.set('file', optimizedFile, optimizedFile.name);
    formData.set('rotation', String(getPreviewRotation(state.currentResult)));
    formData.append('calibration', JSON.stringify(state.calibration));
    return formData;
  });
}

singleForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  singleOutput.innerHTML = '<p>Enhancing image (B&amp;W) and optimizing...</p>';
  singleDebug.innerHTML = '';
  state.corrections = {};
  state.overlayMode = 'overlay';

  try {
    const formData = await buildSingleScanFormData();
    singleOutput.innerHTML = '<p>Uploading enhanced image...</p>';
    const result = await postForm('/api/scan', formData);
    state.previewRotation = getAppliedRotation(result);
    state.currentResult = result;
    singleOutput.innerHTML = renderSingle(result);
    singleDebug.innerHTML = renderDiagnostics(result);
  } catch (error) {
    singleOutput.innerHTML = `<p class="bad">${error.message}</p>`;
    singleDebug.innerHTML = '';
  }
});

bulkForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  bulkSummary.innerHTML = '<p>Enhancing images (B&amp;W) and optimizing...</p>';
  bulkOutput.innerHTML = '';

  try {
    const selectedFiles = Array.from(bulkFileInput.files || []);
    if (!selectedFiles.length) {
      throw new Error('Please select one or more image files first.');
    }

    const optimizedFiles = await compressSelectedFiles(selectedFiles, (index, total) => {
      bulkSummary.innerHTML = `<p>Enhancing image ${index + 1} of ${total}...</p>`;
    });

    const formData = new FormData(bulkForm);
    formData.delete('files');
    optimizedFiles.forEach((file) => {
      formData.append('files', file, file.name);
    });
    formData.set('rotation', '0');
    formData.append('calibration', JSON.stringify(state.calibration));
    bulkSummary.innerHTML = '<p>Uploading enhanced images...</p>';
    const result = await postForm('/api/scan-bulk', formData);

    bulkSummary.innerHTML = `
      <div class="kpi">
        <div>Files<br><strong>${result.summary.totalFiles}</strong></div>
        <div>Total Right<br><span class="good">${result.summary.correct}</span></div>
        <div>Total Wrong<br><span class="bad">${result.summary.wrong}</span></div>
      </div>
      <p><strong>Aggregate Score:</strong> ${result.summary.score.toFixed(2)}%</p>
    `;

    bulkOutput.innerHTML = renderBulkTable(result.items || []);
  } catch (error) {
    bulkSummary.innerHTML = `<p class="bad">${error.message}</p>`;
  }
});

document.getElementById('calibration-form').addEventListener('input', (event) => {
  const target = event.target;
  if (!(target instanceof HTMLInputElement)) {
    return;
  }

  const value = Number(target.value);
  if (!Number.isFinite(value)) {
    return;
  }

  if (target.dataset.scope === 'global') {
    state.calibration[target.dataset.key] = value;
  }

  if (target.dataset.scope === 'block') {
    const index = Number(target.dataset.index);
    state.calibration.blocks[index][target.dataset.key] = value;
  }
});

singleDebug.addEventListener('change', (event) => {
  const target = event.target;
  if (!(target instanceof HTMLSelectElement) || !target.classList.contains('correction-select')) {
    return;
  }

  const qn = target.dataset.qn;
  if (target.value) {
    state.corrections[qn] = target.value;
  } else {
    delete state.corrections[qn];
  }

  if (state.currentResult) {
    singleOutput.innerHTML = renderSingle(state.currentResult);
    singleDebug.innerHTML = renderDiagnostics(state.currentResult);
  }
});

singleDebug.addEventListener('click', (event) => {
  const target = event.target;
  if (!(target instanceof HTMLButtonElement)) {
    return;
  }

  if (target.id === 'btn-rotate-left' || target.id === 'btn-rotate-right' || target.id === 'btn-rotate-reset') {
    if (!hasSingleSourceFile()) {
      singleOutput.innerHTML = '<p class="bad">Select or capture an image first, then rotate the preview.</p>';
      return;
    }

    if (target.id === 'btn-rotate-left') {
      state.previewRotation = normalizeRotation(getPreviewRotation(state.currentResult) - 90);
    } else if (target.id === 'btn-rotate-right') {
      state.previewRotation = normalizeRotation(getPreviewRotation(state.currentResult) + 90);
    } else {
      state.previewRotation = getAppliedRotation(state.currentResult);
    }

    if (state.currentResult) {
      singleOutput.innerHTML = renderSingle(state.currentResult);
      singleDebug.innerHTML = renderDiagnostics(state.currentResult);
    }
    return;
  }

  if (target.dataset.adjustAction === 'set-mode') {
    setSelectedTarget(dragState.selectedBlockIndex ?? 0, target.dataset.mode || 'move');
    if (state.currentResult) {
      singleDebug.innerHTML = renderDiagnostics(state.currentResult);
    }
    return;
  }

  if (target.dataset.adjustAction === 'set-step') {
    state.nudgeStep = target.dataset.step === 'coarse' ? 'coarse' : 'fine';
    if (state.currentResult) {
      singleDebug.innerHTML = renderDiagnostics(state.currentResult);
    }
    return;
  }

  if (target.dataset.adjustAction === 'select-block') {
    const blockIndex = clamp(Number(target.dataset.blockIndex || 0), 0, state.calibration.blocks.length - 1);
    setSelectedTarget(blockIndex, dragState.selectedMode || 'move');
    if (state.currentResult) {
      singleDebug.innerHTML = renderDiagnostics(state.currentResult);
    }
    return;
  }

  if (target.dataset.adjustAction === 'prev-block' || target.dataset.adjustAction === 'next-block') {
    const delta = target.dataset.adjustAction === 'prev-block' ? -1 : 1;
    const nextIndex = clamp((dragState.selectedBlockIndex ?? 0) + delta, 0, state.calibration.blocks.length - 1);
    setSelectedTarget(nextIndex, dragState.selectedMode || 'move');
    if (state.currentResult) {
      singleDebug.innerHTML = renderDiagnostics(state.currentResult);
    }
    return;
  }

  if (target.dataset.adjustAction === 'nudge') {
    const step = state.nudgeStep === 'coarse' ? 10 : 3;
    const dx = Number(target.dataset.dx || 0) * step;
    const dy = Number(target.dataset.dy || 0) * step;
    applySelectedTargetNudge(dx, dy, { disableSnap: true });
    return;
  }

  if (target.dataset.adjustAction === 'resize-quick') {
    const step = state.nudgeStep === 'coarse' ? 10 : 3;
    const dx = Number(target.dataset.resizeDx || 0) * step;
    const dy = Number(target.dataset.resizeDy || 0) * step;
    const originalMode = dragState.selectedMode || 'move';
    setSelectedTarget(dragState.selectedBlockIndex ?? 0, 'resize');
    applySelectedTargetNudge(dx, dy, { disableSnap: true });
    setSelectedTarget(dragState.selectedBlockIndex ?? 0, originalMode);
    if (state.currentResult) {
      singleDebug.innerHTML = renderDiagnostics(state.currentResult);
    }
    return;
  }

  if (target.id === 'btn-apply-rescan') {
    if (!hasSingleSourceFile()) {
      singleOutput.innerHTML = '<p class="bad">Select or capture an image first, then use Apply & Rescan.</p>';
      return;
    }
    singleForm.requestSubmit();
    return;
  }

  if (!target.classList.contains('overlay-mode-btn')) {
    return;
  }

  state.overlayMode = target.dataset.overlayMode;
  if (state.currentResult) {
    singleDebug.innerHTML = renderDiagnostics(state.currentResult);
  }
});

singleDebug.addEventListener('pointerdown', (event) => {
  const target = event.target;
  if (!(target instanceof Element)) {
    return;
  }

  const stage = target.closest('#drag-stage');
  if (!stage) {
    return;
  }
  stage.focus();

  const handle = target.closest('.drag-handle');
  const splitLine = target.closest('.drag-split');
  const rowGuide = target.closest('.drag-row-guide');
  const block = target.closest('.drag-block');

  if (splitLine) {
    const index = Number(splitLine.getAttribute('data-block-index'));
    setSelectedTarget(index, 'split');
    startDrag(event, 'split', index, stage);
    event.preventDefault();
    return;
  }

  if (rowGuide) {
    const index = Number(rowGuide.getAttribute('data-block-index'));
    const guide = rowGuide.getAttribute('data-guide');
    if (guide === 'top') {
      setSelectedTarget(index, 'rowTop');
      startDrag(event, 'rowTop', index, stage);
    } else {
      setSelectedTarget(index, 'rowBottom');
      startDrag(event, 'rowBottom', index, stage);
    }
    event.preventDefault();
    return;
  }

  if (handle) {
    const index = Number(handle.getAttribute('data-block-index'));
    const role = handle.getAttribute('data-role');
    if (role === 'split') {
      setSelectedTarget(index, 'split');
      startDrag(event, 'split', index, stage);
    } else if (role === 'rowTop') {
      setSelectedTarget(index, 'rowTop');
      startDrag(event, 'rowTop', index, stage);
    } else if (role === 'rowBottom') {
      setSelectedTarget(index, 'rowBottom');
      startDrag(event, 'rowBottom', index, stage);
    } else {
      setSelectedTarget(index, 'resize');
      startDrag(event, 'resize', index, stage);
    }
    event.preventDefault();
    return;
  }

  if (block) {
    const index = Number(block.getAttribute('data-block-index'));
    setSelectedTarget(index, 'move');
    startDrag(event, 'move', index, stage);
    event.preventDefault();
  }
});

window.addEventListener('pointermove', onDragMove);
window.addEventListener('pointerup', stopDrag);
window.addEventListener('keydown', nudgeSelectedTarget);
window.addEventListener('resize', () => {
  if (!state.currentResult) {
    return;
  }
  singleDebug.innerHTML = renderDiagnostics(state.currentResult);
});

presetSelect.addEventListener('change', () => {
  applyPreset(presetSelect.value);
});

document.getElementById('btn-save-preset').addEventListener('click', () => {
  const name = presetNameInput.value.trim();
  if (!name) {
    calibrationOutput.innerHTML = '<p class="bad">Enter a preset name first.</p>';
    return;
  }

  state.presets[name] = deepClone(state.calibration);
  saveStoredPresets();
  updatePresetSelect();
  presetSelect.value = name;
  presetNameInput.value = '';
  calibrationOutput.innerHTML = `<p class="good">Preset saved: ${name}</p>`;
});

document.getElementById('btn-delete-preset').addEventListener('click', () => {
  const name = presetSelect.value;
  if (!name || name === DEFAULT_PRESET_NAME) {
    calibrationOutput.innerHTML = '<p class="bad">Select a saved preset to delete.</p>';
    return;
  }

  delete state.presets[name];
  saveStoredPresets();
  updatePresetSelect();
  presetSelect.value = DEFAULT_PRESET_NAME;
  calibrationOutput.innerHTML = `<p class="good">Preset deleted: ${name}</p>`;
});

document.getElementById('btn-reset-calibration').addEventListener('click', async () => {
  await loadDefaultCalibration();
  presetSelect.value = DEFAULT_PRESET_NAME;
});

btnDownloadTemplate.addEventListener('click', async () => {
  try {
    window.open(buildApiUrl('/api/answer-key/template?total=35'), '_blank');
    keyOutput.innerHTML = '<p class="good">Template download started.</p>';
  } catch (error) {
    keyOutput.innerHTML = `<p class="bad">Download failed: ${error.message}</p>`;
  }
});

btnUploadKey.addEventListener('click', async () => {
  try {
    if (!keyFileInput.files || !keyFileInput.files[0]) {
      keyOutput.innerHTML = '<p class="bad">Please select a file first.</p>';
      return;
    }

    const formData = new FormData();
    formData.append('file', keyFileInput.files[0]);
    formData.append('total', 35);

    const res = await fetch(buildApiUrl('/api/answer-key/upload'), {
      method: 'POST',
      body: formData,
    });
    const data = await res.json();

    if (!res.ok) {
      const errors = (data.errors || []).join('<br>');
      keyOutput.innerHTML = `<p class="bad">Upload failed:<br>${errors}</p>`;
      return;
    }

    const warnings = (data.warnings || []).length ? `<br><small>${data.warnings.join('<br>')}</small>` : '';
    keyOutput.innerHTML = `<p class="good">${data.message}${warnings}</p>`;
    keyFileInput.value = '';
    setTimeout(loadKeyStatus, 300);
  } catch (error) {
    keyOutput.innerHTML = `<p class="bad">Upload error: ${error.message}</p>`;
  }
});

themeToggle.addEventListener('click', () => {
  const current = document.documentElement.getAttribute('data-theme') || 'light';
  applyTheme(current === 'dark' ? 'light' : 'dark');
});

singleFileInput.addEventListener('change', () => {
  state.scanSourceFile = null;
  state.previewRotation = 0;
  if (scannerStatus) {
    scannerStatus.textContent = singleFileInput.files?.[0]
      ? `Selected from gallery: ${singleFileInput.files[0].name}`
      : 'Scanner not active.';
  }
});

btnOpenScanner.addEventListener('click', async () => {
  await startScanner();
});

btnCloseScanner.addEventListener('click', () => {
  stopScanner();
  scannerPanel.classList.add('hidden');
  scannerStatus.textContent = state.scanSourceFile
    ? `Captured scan ready: ${state.scanSourceFile.name}`
    : 'Scanner closed.';
});

btnCaptureScan.addEventListener('click', async () => {
  try {
    await captureScannerImage();
    stopScanner();
    scannerPanel.classList.add('hidden');
    singleOutput.innerHTML = `<p class="good">Captured scan ready: ${state.scanSourceFile.name}</p>`;
    scannerStatus.textContent = `Captured scan ready: ${state.scanSourceFile.name}`;
  } catch (error) {
    scannerStatus.textContent = error.message || 'Capture failed.';
  }
});

btnHardwareScan.addEventListener('click', async () => {
  if (!state.capabilities?.hardwareScanner?.supported) {
    const reason = state.capabilities?.hardwareScanner?.reason || 'Hardware scanner is unavailable on this server.';
    singleOutput.innerHTML = `<p class="bad">${reason}</p>`;
    return;
  }

  const scannerHost = getHardwareScannerApiBase() || 'current API host';
  singleOutput.innerHTML = `<p>Waiting for hardware scanner from ${scannerHost}... follow the scanner dialog.</p>`;
  singleDebug.innerHTML = '';
  state.corrections = {};
  state.overlayMode = 'overlay';

  try {
    const formData = new FormData(singleForm);
    formData.set('rotation', String(getPreviewRotation(state.currentResult)));
    formData.append('calibration', JSON.stringify(state.calibration));
    const result = await postForm(buildHardwareScannerApiUrl('/api/scan-hardware'), formData);
    state.previewRotation = getAppliedRotation(result);
    state.currentResult = result;
    state.scanSourceFile = null;
    singleOutput.innerHTML = renderSingle(result);
    singleDebug.innerHTML = renderDiagnostics(result);
  } catch (error) {
    singleOutput.innerHTML = `<p class="bad">Hardware scan failed: ${error.message}</p>`;
  }
});

window.addEventListener('beforeunload', () => {
  stopScanner();
});

async function init() {
  applyTheme(getPreferredTheme());
  state.presets = getStoredPresets();
  updatePresetSelect();
  await Promise.all([loadDefaultCalibration(true), loadKeyStatus(), loadCapabilities()]);
  presetSelect.value = DEFAULT_PRESET_NAME;
  setInterval(loadKeyStatus, 5000);
}

init();
