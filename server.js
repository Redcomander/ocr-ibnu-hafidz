const path = require('path');
const fs = require('fs');
const os = require('os');
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const { execFile } = require('child_process');
const { promisify } = require('util');
const {
  DEFAULT_CALIBRATION,
  loadAnswerKey,
  sanitizeCalibration,
  sanitizeRotation,
  scanBuffer,
  generateAnswerKeyTemplate,
  parseAnswerKeyFromText,
  validateAnswerKey,
} = require('./lib/ocr-core');

const execFileAsync = promisify(execFile);

const app = express();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024,
    files: 30,
  },
});

const PORT = process.env.PORT || 3099;
const defaultKeyPath = path.resolve(__dirname, 'answer_key.json');

function getKeyMap() {
  if (!fs.existsSync(defaultKeyPath)) {
    return null;
  }
  return loadAnswerKey(defaultKeyPath);
}

function getCapabilities() {
  const hardwareScannerSupported = process.platform === 'win32';
  return {
    hardwareScanner: {
      supported: hardwareScannerSupported,
      reason: hardwareScannerSupported ? null : 'Hardware scanner endpoint is available only on Windows host with WIA scanner support.',
    },
  };
}

async function acquireFromWindowsScanner() {
  if (process.platform !== 'win32') {
    throw new Error('Hardware scanner endpoint currently supports Windows only.');
  }

  const tempFile = path.join(os.tmpdir(), `ocr_scanner_${Date.now()}.jpg`);
  const escapedPath = tempFile.replace(/'/g, "''");
  const jpegFormatGuid = '{B96B3CAE-0728-11D3-9D7B-0000F81EF32E}';

  const script = [
    "$ErrorActionPreference = 'Stop'",
    `$outputPath = '${escapedPath}'`,
    '$dialog = New-Object -ComObject WIA.CommonDialog',
    `$image = $dialog.ShowAcquireImage(1,0,0,'${jpegFormatGuid}',$false,$true,$false)`,
    'if ($null -eq $image) { throw "Scanner capture was cancelled." }',
    '$image.SaveFile($outputPath)',
    'Write-Output $outputPath',
  ].join('; ');

  try {
    await execFileAsync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
      timeout: 180000,
      windowsHide: true,
    });
    return fs.readFileSync(tempFile);
  } finally {
    if (fs.existsSync(tempFile)) {
      fs.unlinkSync(tempFile);
    }
  }
}

app.use(express.json());
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});

app.get('/api/capabilities', (_req, res) => {
  res.json(getCapabilities());
});

app.get('/api/calibration/default', (_req, res) => {
  res.json({ calibration: DEFAULT_CALIBRATION });
});

app.post('/api/scan', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const total = Number(req.body.total || 35);
    const lang = String(req.body.lang || 'eng');
    const rotation = sanitizeRotation(req.body.rotation || 0);
    const keyMap = getKeyMap();
    const calibration = req.body.calibration ? sanitizeCalibration(JSON.parse(String(req.body.calibration))) : DEFAULT_CALIBRATION;

    const result = await scanBuffer({
      fileBuffer: req.file.buffer,
      keyMap,
      total,
      lang,
      rotation,
      includeDebug: String(req.body.debug || 'true') !== 'false',
      calibration,
    });

    return res.json({
      fileName: req.file.originalname,
      ...result,
    });
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Scan failed' });
  }
});

app.post('/api/scan-hardware', async (req, res) => {
  try {
    const capabilities = getCapabilities();
    if (!capabilities.hardwareScanner.supported) {
      return res.status(501).json({ error: capabilities.hardwareScanner.reason });
    }

    const total = Number(req.body.total || 35);
    const lang = String(req.body.lang || 'eng');
    const rotation = sanitizeRotation(req.body.rotation || 0);
    const keyMap = getKeyMap();
    const calibration = req.body.calibration ? sanitizeCalibration(JSON.parse(String(req.body.calibration))) : DEFAULT_CALIBRATION;
    const scannedBuffer = await acquireFromWindowsScanner();

    const result = await scanBuffer({
      fileBuffer: scannedBuffer,
      keyMap,
      total,
      lang,
      rotation,
      includeDebug: String(req.body.debug || 'true') !== 'false',
      calibration,
    });

    return res.json({
      fileName: `hardware_scan_${Date.now()}.jpg`,
      ...result,
    });
  } catch (error) {
    const message = error.message || 'Hardware scan failed';
    const lowered = message.toLowerCase();
    const status = lowered.includes('cancel') ? 400 : 500;
    return res.status(status).json({ error: message });
  }
});

app.post('/api/scan-bulk', upload.array('files', 30), async (req, res) => {
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: 'No files uploaded' });
    }

    const total = Number(req.body.total || 35);
    const lang = String(req.body.lang || 'eng');
    const rotation = sanitizeRotation(req.body.rotation || 0);
    const keyMap = getKeyMap();
    const calibration = req.body.calibration ? sanitizeCalibration(JSON.parse(String(req.body.calibration))) : DEFAULT_CALIBRATION;

    const items = [];

    for (const file of req.files) {
      const scan = await scanBuffer({
        fileBuffer: file.buffer,
        keyMap,
        total,
        lang,
        rotation,
        includeDebug: false,
        calibration,
      });

      items.push({
        fileName: file.originalname,
        ...scan,
      });
    }

    const summary = items.reduce(
      (acc, item) => {
        if (!item.score) {
          return acc;
        }

        acc.totalFiles += 1;
        acc.correct += item.score.correct;
        acc.wrong += item.score.wrong;
        acc.questions += item.score.total;
        return acc;
      },
      { totalFiles: 0, correct: 0, wrong: 0, questions: 0 }
    );

    summary.score = summary.questions
      ? Number(((summary.correct / summary.questions) * 100).toFixed(2))
      : 0;

    return res.json({
      summary,
      items,
    });
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Bulk scan failed' });
  }
});

app.get('/api/answer-key/template', (_req, res) => {
  const totalQuestions = Number(_req.query.total || 35);
  const template = generateAnswerKeyTemplate(totalQuestions);

  res.set('Content-Type', 'application/json');
  res.set('Content-Disposition', `attachment; filename="answer_key_template_${totalQuestions}.json"`);
  res.send(JSON.stringify(template, null, 2));
});

app.post('/api/answer-key/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const totalQuestions = Number(req.body.total || 35);
    let keyObj;

    if (req.file.mimetype === 'application/json' || req.file.originalname.endsWith('.json')) {
      keyObj = JSON.parse(req.file.buffer.toString('utf-8'));
    } else {
      keyObj = parseAnswerKeyFromText(req.file.buffer.toString('utf-8'));
    }

    const validation = validateAnswerKey(keyObj, totalQuestions);
    if (!validation.valid) {
      return res.status(400).json({
        error: 'Invalid answer key',
        errors: validation.errors,
        warnings: validation.warnings,
      });
    }

    fs.writeFileSync(defaultKeyPath, JSON.stringify(keyObj, null, 2));

    return res.json({
      success: true,
      message: `Answer key uploaded with ${Object.keys(keyObj).length} questions`,
      warnings: validation.warnings,
    });
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Key upload failed' });
  }
});

app.get('/api/answer-key/current', (_req, res) => {
  if (!fs.existsSync(defaultKeyPath)) {
    return res.json({ loaded: false, key: null });
  }

  const keyObj = JSON.parse(fs.readFileSync(defaultKeyPath, 'utf-8'));
  const total = Object.keys(keyObj).length;

  return res.json({
    loaded: true,
    count: total,
    preview: Object.fromEntries(Object.entries(keyObj).slice(0, 5)),
  });
});

app.listen(PORT, () => {
  console.log(`OCR web server running at http://localhost:${PORT}`);
});
