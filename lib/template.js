'use strict';

const fs = require('fs');
const path = require('path');

// Standard block layout positions (3 columns per row, up to 3 rows = 9 blocks max)
// Matches the existing calibration preset layout
const BLOCK_COL_POSITIONS = [
  { x: 0.12, w: 0.27 },
  { x: 0.43, w: 0.27 },
  { x: 0.73, w: 0.23 },
];

const BLOCK_ROW_POSITIONS = [
  { y: 0.37, h: 0.32 },
  { y: 0.68, h: 0.28 },
  { y: 0.95, h: 0.20 },
];

const STANDARD_BLOCK_SIZE = 10;

/**
 * Extract plain text from an HTML snippet (strip tags).
 */
function stripHtml(html) {
  return html.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&#\d+;/g, '').trim();
}

/**
 * Parse all tables from an HTML string.
 * Returns an array of tables, each table is an array of rows,
 * each row is an array of cell text strings.
 */
function parseTablesFromHtml(html) {
  const tables = [];
  const tableRe = /<table[\s\S]*?>([\s\S]*?)<\/table>/gi;
  let tableMatch;

  while ((tableMatch = tableRe.exec(html)) !== null) {
    const tableHtml = tableMatch[1];
    const rows = [];

    const rowRe = /<tr[\s\S]*?>([\s\S]*?)<\/tr>/gi;
    let rowMatch;

    while ((rowMatch = rowRe.exec(tableHtml)) !== null) {
      const rowHtml = rowMatch[1];
      const cells = [];

      const cellRe = /<t[dh][\s\S]*?>([\s\S]*?)<\/t[dh]>/gi;
      let cellMatch;

      while ((cellMatch = cellRe.exec(rowHtml)) !== null) {
        cells.push(stripHtml(cellMatch[1]));
      }

      if (cells.length > 0) {
        rows.push(cells);
      }
    }

    if (rows.length > 0) {
      tables.push(rows);
    }
  }

  return tables;
}

/**
 * Check if a cell text looks like a question number.
 * Handles "1", "1.", "1)" formats.
 */
function isQuestionNumber(text) {
  return /^\d+\.?[).]?\s*$/.test(String(text || '').trim());
}

/**
 * Check if a cell text looks like an option label (A-E).
 */
function isOptionLabel(text) {
  return /^[ABCDE]$/i.test(String(text || '').trim());
}

/**
 * Parse a single answer-grid table.
 * The table may have multiple question groups side-by-side per row.
 * e.g. row: [1., A, B, C, D, (spacer), 11., A, B, C, D, (spacer), 21., A, B, C, D]
 *
 * Returns array of groups: [{ startQ, rowCount, optionCount }]
 */
function parseAnswerGridTable(rows) {
  if (!rows || rows.length === 0) return [];

  const firstRow = rows[0];

  // Find all column positions that start a question group (question number cells)
  const groupStartCols = [];
  for (let col = 0; col < firstRow.length; col++) {
    if (isQuestionNumber(firstRow[col])) {
      // Count options immediately following
      let optCount = 0;
      let j = col + 1;
      while (j < firstRow.length && isOptionLabel(firstRow[j])) {
        optCount++;
        j++;
      }
      if (optCount > 0) {
        const qText = firstRow[col].replace(/\D/g, '');
        groupStartCols.push({ col, startQ: Number(qText) || groupStartCols.length + 1, optCount });
      }
    }
  }

  if (groupStartCols.length === 0) return [];

  // Count question rows for the first group (rows where that column has a question number)
  const rowCount = rows.filter((row) => isQuestionNumber(row[groupStartCols[0].col])).length;

  return groupStartCols.map((g) => ({
    startQ: g.startQ,
    rowCount,
    optionCount: g.optCount,
  }));
}

/**
 * Analyze extracted tables to determine answer sheet structure.
 * Returns { total, optionChoices, tableCount, groups, questionsPerTable }
 */
function analyzeAnswerSheetTables(tables) {
  if (!tables || tables.length === 0) {
    return { total: 35, optionChoices: 'ABCDE', tableCount: 0, groups: [], questionsPerTable: [] };
  }

  // Only process tables that contain answer grids (have question number cells)
  const allGroups = [];
  const questionsPerTable = [];

  for (const table of tables) {
    const groups = parseAnswerGridTable(table);
    const tableQuestions = groups.reduce((sum, g) => sum + g.rowCount, 0);
    questionsPerTable.push(tableQuestions);
    allGroups.push(...groups);
  }

  const totalFromGroups = allGroups.reduce((sum, g) => sum + g.rowCount, 0);
  const total = totalFromGroups > 0 ? totalFromGroups : 35;

  // Determine option choices from the maximum option count found
  const maxOptions = allGroups.reduce((m, g) => Math.max(m, g.optionCount), 0);
  const optionChoices = maxOptions >= 5 ? 'ABCDE' : 'ABCD';

  return {
    total,
    optionChoices,
    tableCount: tables.length,
    groups: allGroups,
    questionsPerTable,
  };
}

/**
 * Build a calibration object from the analyzed template groups.
 * Each group becomes one calibration block, positioned using the standard grid.
 */
function buildCalibrationFromAnalysis({ total, optionChoices, groups }) {
  const blocks = [];
  const maxBlocks = BLOCK_COL_POSITIONS.length * BLOCK_ROW_POSITIONS.length;

  // If we have explicit groups from parsing, use them
  if (groups && groups.length > 0) {
    groups.slice(0, maxBlocks).forEach((group, blockIdx) => {
      const col = blockIdx % BLOCK_COL_POSITIONS.length;
      const row = Math.floor(blockIdx / BLOCK_COL_POSITIONS.length);
      const colPos = BLOCK_COL_POSITIONS[col];
      const rowPos = BLOCK_ROW_POSITIONS[row];
      const heightScale = group.rowCount / STANDARD_BLOCK_SIZE;

      blocks.push({
        startQ: group.startQ,
        count: group.rowCount,
        x: colPos.x,
        y: rowPos.y,
        w: colPos.w,
        h: Number(Math.min(rowPos.h, rowPos.h * heightScale + 0.05).toFixed(4)),
        questionColW: 0.1,
        rowTop: 0,
        rowBottom: 1,
      });
    });
  } else {
    // Fallback: auto-distribute based on total
    let questionStart = 1;
    let remaining = total;
    let blockIdx = 0;

    while (remaining > 0 && blockIdx < maxBlocks) {
      const count = Math.min(STANDARD_BLOCK_SIZE, remaining);
      const col = blockIdx % BLOCK_COL_POSITIONS.length;
      const row = Math.floor(blockIdx / BLOCK_COL_POSITIONS.length);
      const colPos = BLOCK_COL_POSITIONS[col];
      const rowPos = BLOCK_ROW_POSITIONS[row];

      blocks.push({
        startQ: questionStart,
        count,
        x: colPos.x,
        y: rowPos.y,
        w: colPos.w,
        h: Number((rowPos.h * (count / STANDARD_BLOCK_SIZE)).toFixed(4)),
        questionColW: 0.1,
        rowTop: 0,
        rowBottom: 1,
      });

      questionStart += count;
      remaining -= count;
      blockIdx += 1;
    }
  }

  return {
    markedThreshold: 45,
    confidenceGap: 2.5,
    questionColW: 0.1,
    centerPadX: 0.15,
    centerPadY: 0.2,
    optionChoices,
    blocks,
  };
}

/**
 * Parse a DOCX buffer and return the template analysis + calibration.
 * Requires mammoth package.
 */
async function parseDocxTemplate(docxBuffer) {
  // mammoth is an optional dependency for DOCX support
  let mammoth;
  try {
    mammoth = require('mammoth');
  } catch {
    throw new Error('mammoth package is not installed. Run: npm install mammoth');
  }

  const result = await mammoth.convertToHtml({ buffer: docxBuffer });
  const html = result.value;

  const tables = parseTablesFromHtml(html);
  const analysis = analyzeAnswerSheetTables(tables);
  const calibration = buildCalibrationFromAnalysis(analysis);

  return {
    ...analysis,
    calibration,
  };
}

/**
 * Read stored template grid from disk.
 * Returns null if no template is registered.
 */
function readStoredTemplate(templatePath) {
  if (!fs.existsSync(templatePath)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(templatePath, 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * Write template grid to disk.
 */
function writeStoredTemplate(templatePath, data) {
  const dir = path.dirname(templatePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(templatePath, JSON.stringify(data, null, 2));
}

module.exports = {
  parseDocxTemplate,
  analyzeAnswerSheetTables,
  buildCalibrationFromAnalysis,
  readStoredTemplate,
  writeStoredTemplate,
};
