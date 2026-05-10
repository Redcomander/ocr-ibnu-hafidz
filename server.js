const path = require('path');
const fs = require('fs');
const os = require('os');
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const sharp = require('sharp');
const jwt = require('jsonwebtoken');
const { execFile } = require('child_process');
const { promisify } = require('util');
const {
  getCalibrationPreset,
  DEFAULT_CALIBRATION,
  loadAnswerKey,
  normalizeOptionChoices,
  sanitizeCalibration,
  sanitizeRotation,
  scanBuffer,
  generateAnswerKeyTemplate,
  parseAnswerKeyFromText,
  validateAnswerKey,
} = require('./lib/ocr-core');
const {
  parseDocxTemplate,
  parsePdfTemplate,
  buildCalibrationFromAnalysis,
  readStoredTemplate,
  writeStoredTemplate,
} = require('./lib/template');

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
const answerKeysPath = path.resolve(__dirname, 'answer_keys.json');
const templateGridPath = path.resolve(__dirname, 'template-grid.json');
const AUTH_MODE = String(process.env.OCR_AUTH_MODE || 'none').trim().toLowerCase();
const MAIN_JWT_SECRET = String(process.env.MAIN_JWT_SECRET || '').trim();
const MAIN_AUTH_ME_URL = String(process.env.MAIN_AUTH_ME_URL || '').trim();
// Main Go backend — used to persist answer keys so they survive OCR service resets.
const MAIN_API_URL = String(process.env.MAIN_API_URL || '').trim();
const OCR_SERVICE_TOKEN = String(process.env.OCR_SERVICE_TOKEN || '').trim();
const PUBLIC_API_PATHS = new Set(['/api/health', '/api/capabilities', '/api/auth/status']);

function parseBearerToken(authHeader) {
  const value = String(authHeader || '').trim();
  if (!value) {
    return '';
  }
  const parts = value.split(' ');
  if (parts.length === 2 && /^bearer$/i.test(parts[0])) {
    return String(parts[1] || '').trim();
  }
  return '';
}

async function validateTokenWithMainApi(token) {
  if (!MAIN_AUTH_ME_URL) {
    throw new Error('MAIN_AUTH_ME_URL is not configured.');
  }

  const response = await fetch(MAIN_AUTH_ME_URL, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
    },
  });

  if (!response.ok) {
    throw new Error(`Main auth API rejected token (status ${response.status}).`);
  }

  const payload = await response.json();
  return payload;
}

async function resolveAuthenticatedUser(token) {
  if (!token) {
    throw new Error('Missing bearer token.');
  }

  if (MAIN_AUTH_ME_URL) {
    return validateTokenWithMainApi(token);
  }

  if (!MAIN_JWT_SECRET) {
    throw new Error('MAIN_JWT_SECRET is not configured.');
  }

  return jwt.verify(token, MAIN_JWT_SECRET);
}

async function authMiddleware(req, res, next) {
  try {
    if (AUTH_MODE === 'none') {
      return next();
    }

    if (!req.path.startsWith('/api/') || PUBLIC_API_PATHS.has(req.path)) {
      return next();
    }

    const token = parseBearerToken(req.get('Authorization'));
    const user = await resolveAuthenticatedUser(token);
    req.authUser = user;
    return next();
  } catch (error) {
    return res.status(401).json({ error: error.message || 'Unauthorized' });
  }
}

function getKeyMap() {
  if (!fs.existsSync(defaultKeyPath)) {
    return null;
  }
  return loadAnswerKey(defaultKeyPath);
}

function readAnswerKeysStore() {
  if (!fs.existsSync(answerKeysPath)) {
    return [];
  }

  try {
    const raw = fs.readFileSync(answerKeysPath, 'utf-8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeAnswerKeysStore(items) {
  fs.writeFileSync(answerKeysPath, JSON.stringify(items, null, 2));
}

function normalizeKeyMap(input) {
  if (!input || typeof input !== 'object') {
    return {};
  }

  const result = {};
  for (const [key, value] of Object.entries(input)) {
    const question = Number(key);
    if (!Number.isFinite(question) || question <= 0) {
      continue;
    }

    const cleaned = String(value || '').trim().toUpperCase();
    if (!cleaned) {
      continue;
    }
    result[String(question)] = cleaned;
  }
  return result;
}

function normalizeAnswerArray(answers) {
  if (!Array.isArray(answers)) {
    return {};
  }

  const mapped = {};
  answers.forEach((value, idx) => {
    const cleaned = String(value || '').trim().toUpperCase();
    if (!cleaned) {
      return;
    }
    mapped[String(idx + 1)] = cleaned;
  });
  return mapped;
}

function extractKeyMapFromPayload(payload) {
  if (Array.isArray(payload?.answers)) {
    return normalizeAnswerArray(payload.answers);
  }

  if (payload?.answers && typeof payload.answers === 'object') {
    return normalizeKeyMap(payload.answers);
  }

  if (payload && typeof payload === 'object') {
    return normalizeKeyMap(payload);
  }

  return {};
}

function toAnswerArray(keyMap, total = 35) {
  const size = Math.max(1, Number(total) || 35);
  const out = Array(size).fill('');
  for (let i = 1; i <= size; i += 1) {
    out[i - 1] = String(keyMap?.[String(i)] || '').toUpperCase();
  }
  return out;
}

function toAnswerKeySummary(item) {
  const count = Object.keys(item.keyMap || {}).length;
  return {
    id: item.id,
    name: item.name,
    count,
    preview: Object.fromEntries(Object.entries(item.keyMap || {}).slice(0, 5)),
    created_at: item.createdAt,
    updated_at: item.updatedAt,
  };
}

function findStoredAnswerKeyById(id) {
  const target = String(id || '').trim();
  if (!target) {
    return null;
  }

  const items = readAnswerKeysStore();
  return items.find((item) => String(item.id) === target) || null;
}

function resolveKeyMapForRequest(req) {
  const answerKeyId = String(req.body?.answerKeyId || '').trim();
  if (answerKeyId) {
    const selected = findStoredAnswerKeyById(answerKeyId);
    if (selected && selected.keyMap && typeof selected.keyMap === 'object') {
      return selected.keyMap;
    }
  }

  return getKeyMap();
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

async function runPowerShellScript(script, timeout = 120000) {
  const scriptPath = path.join(os.tmpdir(), `ocr_reader_${Date.now()}_${Math.random().toString(16).slice(2)}.ps1`);

  try {
    fs.writeFileSync(scriptPath, `${script}\n`, 'utf8');

    return await execFileAsync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath], {
      timeout,
      windowsHide: false,
    });
  } catch (error) {
    const stderr = String(error?.stderr || '').trim();
    const stdout = String(error?.stdout || '').trim();
    const base = String(error?.message || 'PowerShell execution failed').trim();
    const detail = stderr || stdout;
    throw new Error(detail ? `${base}\n${detail}` : base);
  } finally {
    if (fs.existsSync(scriptPath)) {
      fs.unlinkSync(scriptPath);
    }
  }
}

function escapePsSingleQuoted(value) {
  return String(value || '').replace(/'/g, "''");
}

function getBufferSignature(buffer, bytes = 12) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    return 'empty';
  }

  return buffer.subarray(0, Math.min(bytes, buffer.length)).toString('hex');
}

async function normalizeScannedImageBuffer(inputBuffer) {
  if (!Buffer.isBuffer(inputBuffer) || inputBuffer.length === 0) {
    throw new Error('Scanner returned an empty image file.');
  }

  try {
    return await sharp(inputBuffer).rotate().png().toBuffer();
  } catch (error) {
    const signature = getBufferSignature(inputBuffer);
    const detail = error?.message ? ` ${error.message}` : '';
    throw new Error(`Scanner returned an unreadable image format. Signature: ${signature}.${detail}`);
  }
}

async function normalizeScannedImageFileOnWindows(inputPath) {
  if (process.platform !== 'win32') {
    throw new Error('Windows scanner file normalization is unavailable on this platform.');
  }

  const outputPath = path.join(os.tmpdir(), `ocr_scanner_normalized_${Date.now()}.png`);
  const escapedInputPath = escapePsSingleQuoted(inputPath);
  const escapedOutputPath = escapePsSingleQuoted(outputPath);
  const script = [
    "$ErrorActionPreference = 'Stop'",
    'Add-Type -AssemblyName System.Drawing',
    `$inputPath = '${escapedInputPath}'`,
    `$outputPath = '${escapedOutputPath}'`,
    '$image = [System.Drawing.Image]::FromFile($inputPath)',
    'try {',
    '  $bitmap = New-Object System.Drawing.Bitmap $image',
    '  try {',
    '    $bitmap.Save($outputPath, [System.Drawing.Imaging.ImageFormat]::Png)',
    '  } finally {',
    '    $bitmap.Dispose()',
    '  }',
    '} finally {',
    '  $image.Dispose()',
    '}',
    'Write-Output $outputPath',
  ].join('\n');

  try {
    const { stdout } = await runPowerShellScript(script, 60000);
    const normalizedPath = String(stdout || '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .pop();

    if (!normalizedPath || !fs.existsSync(normalizedPath)) {
      throw new Error('Windows image normalization did not produce an output file.');
    }

    return {
      buffer: fs.readFileSync(normalizedPath),
      outputPath: normalizedPath,
    };
  } catch (error) {
    if (fs.existsSync(outputPath)) {
      fs.unlinkSync(outputPath);
    }
    throw error;
  }
}

async function listWindowsScanners() {
  if (process.platform !== 'win32') {
    return [];
  }

  const script = [
    "$ErrorActionPreference = 'Stop'",
    '$dm = New-Object -ComObject WIA.DeviceManager',
    '$devices = @()',
    'foreach ($info in $dm.DeviceInfos) {',
    '  if ($info.Type -eq 1) {',
    '    $name = "Unknown scanner"',
    '    $manufacturer = ""',
    '    try { $name = [string]$info.Properties.Item("Name").Value } catch {}',
    '    try { $manufacturer = [string]$info.Properties.Item("Manufacturer").Value } catch {}',
    '    $devices += [PSCustomObject]@{ deviceId = [string]$info.DeviceID; name = $name; manufacturer = $manufacturer }',
    '  }',
    '}',
    '$devices | ConvertTo-Json -Compress -Depth 4',
  ].join('\n');

  const { stdout } = await runPowerShellScript(script, 30000);
  const payload = String(stdout || '').trim();
  if (!payload) {
    return [];
  }

  const parsed = JSON.parse(payload);
  if (Array.isArray(parsed)) {
    return parsed;
  }
  if (parsed && typeof parsed === 'object') {
    return [parsed];
  }
  return [];
}

async function acquireFromWindowsScanner(scannerDeviceId) {
  if (process.platform !== 'win32') {
    throw new Error('Hardware scanner endpoint currently supports Windows only.');
  }

  const tempDir = os.tmpdir();
  const baseName = `ocr_scanner_${Date.now()}`;
  const escapedTempDir = escapePsSingleQuoted(tempDir);
  const escapedBaseName = escapePsSingleQuoted(baseName);
  const escapedDeviceId = escapePsSingleQuoted(scannerDeviceId || '');

  const script = [
    "$ErrorActionPreference = 'Stop'",
    `$tempDir = '${escapedTempDir}'`,
    `$baseName = '${escapedBaseName}'`,
    `$scannerDeviceId = '${escapedDeviceId}'`,
    'function Test-IsBusyError([string]$message) {',
    '  if ([string]::IsNullOrWhiteSpace($message)) { return $false }',
    '  return $message.ToLowerInvariant().Contains("device is busy")',
    '}',
    'function Connect-ScannerDevice($deviceInfo) {',
    '  $lastError = $null',
    '  for ($attempt = 1; $attempt -le 4; $attempt++) {',
    '    try {',
    '      return $deviceInfo.Connect()',
    '    } catch {',
    '      $lastError = $_.Exception.Message',
    '      if (-not (Test-IsBusyError $lastError) -or $attempt -eq 4) { throw }',
    '      Start-Sleep -Milliseconds (600 * $attempt)',
    '    }',
    '  }',
    '  throw $lastError',
    '}',
    'function Convert-ScannerImage($image, $formatGuid, $quality = $null) {',
    '  $imageProcessor = New-Object -ComObject WIA.ImageProcess',
    '  $convertFilter = $imageProcessor.FilterInfos | Where-Object { $_.Name -eq "Convert" } | Select-Object -First 1',
    '  if ($null -eq $convertFilter) { throw "WIA Convert filter is not available." }',
    '  $imageProcessor.Filters.Add($convertFilter.FilterID)',
    '  $imageProcessor.Filters.Item(1).Properties.Item("FormatID").Value = $formatGuid',
    '  if ($null -ne $quality) {',
    '    try { $imageProcessor.Filters.Item(1).Properties.Item("Quality").Value = $quality } catch {}',
    '  }',
    '  return $imageProcessor.Apply($image)',
    '}',
    '$dialog = New-Object -ComObject WIA.CommonDialog',
    '$deviceManager = New-Object -ComObject WIA.DeviceManager',
    '$device = $null',
    'if ([string]::IsNullOrWhiteSpace($scannerDeviceId)) {',
    '  $device = $dialog.ShowSelectDevice(1, $true, $false)',
    '} else {',
    '  $deviceInfo = $deviceManager.DeviceInfos | Where-Object { $_.DeviceID -eq $scannerDeviceId } | Select-Object -First 1',
    '  if ($null -eq $deviceInfo) {',
    '    $device = $dialog.ShowSelectDevice(1, $true, $false)',
    '  } else {',
    '    $device = Connect-ScannerDevice $deviceInfo',
    '  }',
    '}',
    'if ($null -eq $device) { throw "Scanner device selection was cancelled." }',
    '$item = $device.Items.Item(1)',
    '$image = $item.Transfer()',
    'if ($null -eq $image) { throw "Scanner capture was cancelled." }',
    '$formats = @(',
    "  @{ name = 'bmp'; extension = 'bmp'; guid = '{B96B3CAB-0728-11D3-9D7B-0000F81EF32E}' },",
    "  @{ name = 'png'; extension = 'png'; guid = '{B96B3CAF-0728-11D3-9D7B-0000F81EF32E}' },",
    "  @{ name = 'jpeg'; extension = 'jpg'; guid = '{B96B3CAE-0728-11D3-9D7B-0000F81EF32E}' }",
    ')',
    '$lastFormatError = $null',
    'foreach ($format in $formats) {',
    '  try {',
    '    $quality = $null',
    '    if ($format.name -eq "jpeg") { $quality = 85 }',
    '    $converted = Convert-ScannerImage $image $format.guid $quality',
    '    if ($null -eq $converted) { continue }',
    '    $outputPath = Join-Path $tempDir ($baseName + "." + $format.extension)',
    '    if (Test-Path $outputPath) { Remove-Item $outputPath -Force -ErrorAction SilentlyContinue }',
    '    $converted.SaveFile($outputPath)',
    '    if (Test-Path $outputPath) {',
    '      [PSCustomObject]@{ path = $outputPath; format = $format.name } | ConvertTo-Json -Compress',
    '      exit 0',
    '    }',
    '  } catch {',
    '    $lastFormatError = $_.Exception.Message',
    '  }',
    '}',
    'try {',
    '  $converted = Convert-ScannerImage $image "{B96B3CAB-0728-11D3-9D7B-0000F81EF32E}" $null',
    '  if ($null -eq $converted) { throw "Scanner conversion failed." }',
    '  $outputPath = Join-Path $tempDir ($baseName + ".bmp")',
    '  if (Test-Path $outputPath) { Remove-Item $outputPath -Force -ErrorAction SilentlyContinue }',
    '  $converted.SaveFile($outputPath)',
    '  [PSCustomObject]@{ path = $outputPath; format = "native" } | ConvertTo-Json -Compress',
    '} catch {',
    '  if ($lastFormatError) {',
    '    throw ("Scanner transfer failed. Preferred formats could not be captured. Last format error: " + $lastFormatError + ". Native fallback error: " + $_.Exception.Message)',
    '  }',
    '  throw',
    '}',
  ].join('\n');

  let tempFile = null;
  let normalizedTempFile = null;

  try {
    const { stdout } = await runPowerShellScript(script, 120000);
    const payload = String(stdout || '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .pop();

    if (!payload) {
      throw new Error('Scanner did not return a file path.');
    }

    const parsed = JSON.parse(payload);
    tempFile = typeof parsed?.path === 'string' ? parsed.path : null;

    if (!fs.existsSync(tempFile)) {
      throw new Error('Scanner did not return an image file.');
    }

    const scannedBuffer = fs.readFileSync(tempFile);

    try {
      return await normalizeScannedImageBuffer(scannedBuffer);
    } catch (error) {
      const signature = getBufferSignature(scannedBuffer);
      if (!signature.startsWith('424d')) {
        throw error;
      }

      const normalized = await normalizeScannedImageFileOnWindows(tempFile);
      normalizedTempFile = normalized.outputPath;
      return normalized.buffer;
    }
  } catch (error) {
    if (error && (error.killed || error.signal === 'SIGTERM')) {
      throw new Error('Scanner dialog timeout. Make sure the dialog is visible and complete scan within 2 minutes.');
    }
    const detail = String(error?.message || '').toLowerCase();
    if (detail.includes('wia') && detail.includes('class not registered')) {
      throw new Error('WIA is not available on this machine. Install scanner drivers with WIA support.');
    }
    if (detail.includes('device is busy')) {
      throw new Error('Scanner is busy. Close Epson Scan or other scanner apps, wait a few seconds, then try again.');
    }
    throw error;
  } finally {
    if (tempFile && fs.existsSync(tempFile)) {
      fs.unlinkSync(tempFile);
    }
    if (normalizedTempFile && fs.existsSync(normalizedTempFile)) {
      fs.unlinkSync(normalizedTempFile);
    }
  }
}

// ── Main API sync helpers ────────────────────────────────────────────────────
// These functions keep the Go backend DB in sync with the local answer_keys.json.
// When MAIN_API_URL + OCR_SERVICE_TOKEN are configured, answer keys are persisted
// to the Go backend database so a hard reset of this service doesn't lose history.

function mainApiHeaders() {
  return { 'Content-Type': 'application/json', 'X-Service-Token': OCR_SERVICE_TOKEN };
}

async function syncAnswerKeyToMain(record) {
  if (!MAIN_API_URL || !OCR_SERVICE_TOKEN) return;
  try {
    const { mainApiId, name, keyMap, createdAt, updatedAt } = record;
    const body = JSON.stringify({ name, answers: keyMap, total: Object.keys(keyMap || {}).length });

    if (mainApiId) {
      // Update existing record in Go backend
      await fetch(`${MAIN_API_URL}/ocr-service/answer-keys/${mainApiId}`, {
        method: 'PUT',
        headers: mainApiHeaders(),
        body,
      });
    } else {
      // Create new record in Go backend and store returned ID
      const resp = await fetch(`${MAIN_API_URL}/ocr-service/answer-keys`, {
        method: 'POST',
        headers: mainApiHeaders(),
        body,
      });
      if (resp.ok) {
        const data = await resp.json();
        const goId = data?.key?.id;
        if (goId) {
          // Persist the Go backend ID back into the local store
          const items = readAnswerKeysStore();
          const idx = items.findIndex((i) => i.id === record.id);
          if (idx !== -1) {
            items[idx].mainApiId = String(goId);
            writeAnswerKeysStore(items);
          }
        }
      }
    }
  } catch (err) {
    console.error('[ocr-sync] syncAnswerKeyToMain failed:', err.message);
  }
}

async function deleteAnswerKeyFromMain(mainApiId) {
  if (!MAIN_API_URL || !OCR_SERVICE_TOKEN || !mainApiId) return;
  try {
    await fetch(`${MAIN_API_URL}/ocr-service/answer-keys/${mainApiId}`, {
      method: 'DELETE',
      headers: mainApiHeaders(),
    });
  } catch (err) {
    console.error('[ocr-sync] deleteAnswerKeyFromMain failed:', err.message);
  }
}

async function restoreAnswerKeysFromMain() {
  if (!MAIN_API_URL || !OCR_SERVICE_TOKEN) return;
  if (fs.existsSync(answerKeysPath)) {
    try {
      const raw = fs.readFileSync(answerKeysPath, 'utf-8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0) {
        console.log(`[ocr-sync] Local answer_keys.json has ${parsed.length} entries — skipping restore.`);
        return;
      }
    } catch {
      // fall through to restore
    }
  }

  console.log('[ocr-sync] Local answer_keys.json is empty — restoring from Go backend...');
  try {
    const resp = await fetch(`${MAIN_API_URL}/ocr-service/answer-keys`, {
      headers: mainApiHeaders(),
    });
    if (!resp.ok) {
      console.error(`[ocr-sync] restoreAnswerKeysFromMain: Go backend returned ${resp.status}`);
      return;
    }
    const data = await resp.json();
    const remoteKeys = Array.isArray(data?.keys) ? data.keys : [];
    if (remoteKeys.length === 0) {
      console.log('[ocr-sync] No answer keys found in Go backend.');
      return;
    }

    const restored = remoteKeys.map((k) => ({
      id: `restored_${k.id}_${Date.now()}`,
      mainApiId: String(k.id),
      name: k.name,
      keyMap: k.key_map || {},
      createdAt: k.created_at,
      updatedAt: k.updated_at,
    }));

    writeAnswerKeysStore(restored);
    console.log(`[ocr-sync] Restored ${restored.length} answer keys from Go backend.`);
  } catch (err) {
    console.error('[ocr-sync] restoreAnswerKeysFromMain failed:', err.message);
  }
}

app.use(express.json());
app.use(cors());
app.use(authMiddleware);
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});

app.get('/api/capabilities', (_req, res) => {
  res.json(getCapabilities());
});

app.get('/api/auth/status', async (req, res) => {
  if (AUTH_MODE === 'none') {
    return res.json({ enabled: false, authenticated: true, user: null });
  }

  const token = parseBearerToken(req.get('Authorization'));
  if (!token) {
    return res.json({ enabled: true, authenticated: false, user: null });
  }

  try {
    const user = await resolveAuthenticatedUser(token);
    return res.json({ enabled: true, authenticated: true, user });
  } catch {
    return res.json({ enabled: true, authenticated: false, user: null });
  }
});

app.get('/api/scanner/devices', async (_req, res) => {
  try {
    const capabilities = getCapabilities();
    if (!capabilities.hardwareScanner.supported) {
      return res.status(501).json({ error: capabilities.hardwareScanner.reason, devices: [] });
    }

    const devices = await listWindowsScanners();
    return res.json({ devices });
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Failed to list scanners', devices: [] });
  }
});

app.get('/api/calibration/default', (req, res) => {
  const total = Number(req.query.total || 35);
  const optionChoices = normalizeOptionChoices(req.query.optionChoices || req.query.options || 'ABCDE');
  const calibration = sanitizeCalibration(getCalibrationPreset(total), total, optionChoices);
  res.json({ calibration, total, optionChoices });
});

app.post('/api/scan', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const total = Number(req.body.total || 35);
    const optionChoices = normalizeOptionChoices(req.body.optionChoices || req.body.options || 'ABCDE');
    const lang = String(req.body.lang || 'eng');
    const rotation = sanitizeRotation(req.body.rotation || 0);
    const keyMap = resolveKeyMapForRequest(req);
    const calibration = req.body.calibration
      ? sanitizeCalibration(JSON.parse(String(req.body.calibration)), total, optionChoices)
      : sanitizeCalibration(getCalibrationPreset(total), total, optionChoices);

    const result = await scanBuffer({
      fileBuffer: req.file.buffer,
      keyMap,
      total,
      lang,
      rotation,
      optionChoices,
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

app.post('/api/scan-hardware', upload.none(), async (req, res) => {
  try {
    const capabilities = getCapabilities();
    if (!capabilities.hardwareScanner.supported) {
      return res.status(501).json({ error: capabilities.hardwareScanner.reason });
    }

    const body = req.body || {};
    const total = Number(body.total || 35);
    const optionChoices = normalizeOptionChoices(body.optionChoices || body.options || 'ABCDE');
    const lang = String(body.lang || 'eng');
    const rotation = sanitizeRotation(body.rotation || 0);
    const scannerDeviceId = String(body.scannerDeviceId || '').trim();
    const keyMap = resolveKeyMapForRequest(req);
    const calibration = body.calibration
      ? sanitizeCalibration(JSON.parse(String(body.calibration)), total, optionChoices)
      : sanitizeCalibration(getCalibrationPreset(total), total, optionChoices);
    const scannedBuffer = await acquireFromWindowsScanner(scannerDeviceId);

    const result = await scanBuffer({
      fileBuffer: scannedBuffer,
      keyMap,
      total,
      lang,
      rotation,
      optionChoices,
      includeDebug: String(body.debug || 'true') !== 'false',
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
    const optionChoices = normalizeOptionChoices(req.body.optionChoices || req.body.options || 'ABCDE');
    const lang = String(req.body.lang || 'eng');
    const rotation = sanitizeRotation(req.body.rotation || 0);
    const keyMap = resolveKeyMapForRequest(req);
    const calibration = req.body.calibration
      ? sanitizeCalibration(JSON.parse(String(req.body.calibration)), total, optionChoices)
      : sanitizeCalibration(getCalibrationPreset(total), total, optionChoices);

    const items = [];

    for (const file of req.files) {
      const scan = await scanBuffer({
        fileBuffer: file.buffer,
        keyMap,
        total,
        lang,
        rotation,
        optionChoices,
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
  const optionChoices = normalizeOptionChoices(_req.query.optionChoices || _req.query.options || 'ABCDE');
  const template = generateAnswerKeyTemplate(totalQuestions, optionChoices);

  res.set('Content-Type', 'application/json');
  res.set('Content-Disposition', `attachment; filename="answer_key_template_${totalQuestions}.json"`);
  res.send(JSON.stringify(template, null, 2));
});

app.get('/api/answer-key', (_req, res) => {
  const keys = readAnswerKeysStore().map(toAnswerKeySummary);
  return res.json({ keys });
});

app.get('/api/answer-key/:id', (req, res) => {
  const item = findStoredAnswerKeyById(req.params.id);
  if (!item) {
    return res.status(404).json({ error: 'Answer key not found' });
  }

  return res.json({
    id: item.id,
    name: item.name,
    answers: toAnswerArray(item.keyMap || {}, Math.max(35, Object.keys(item.keyMap || {}).length)),
    count: Object.keys(item.keyMap || {}).length,
    created_at: item.createdAt,
    updated_at: item.updatedAt,
  });
});

app.post('/api/answer-key', (req, res) => {
  try {
    const name = String(req.body?.name || '').trim();
    if (!name) {
      return res.status(400).json({ error: 'Nama kunci jawaban wajib diisi' });
    }

    const keyMap = extractKeyMapFromPayload(req.body);
    const totalQuestions = Number(req.body?.total || Math.max(35, Object.keys(keyMap).length || 35));
    const optionChoices = normalizeOptionChoices(req.body?.optionChoices || req.body?.options || 'ABCDE');
    const validation = validateAnswerKey(keyMap, totalQuestions, optionChoices);
    if (!validation.valid) {
      return res.status(400).json({
        error: 'Invalid answer key',
        errors: validation.errors,
        warnings: validation.warnings,
      });
    }

    const now = new Date().toISOString();
    const record = {
      id: `${Date.now()}_${Math.random().toString(16).slice(2, 8)}`,
      name,
      keyMap,
      createdAt: now,
      updatedAt: now,
    };

    const existing = readAnswerKeysStore();
    existing.unshift(record);
    writeAnswerKeysStore(existing);

    // Async sync to Go backend — fire and forget (updates mainApiId in local store)
    syncAnswerKeyToMain(record).catch(() => {});

    return res.status(201).json({ success: true, key: toAnswerKeySummary(record) });
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Failed to save answer key' });
  }
});

app.put('/api/answer-key/:id', (req, res) => {
  try {
    const items = readAnswerKeysStore();
    const idx = items.findIndex((item) => String(item.id) === String(req.params.id));
    if (idx === -1) {
      return res.status(404).json({ error: 'Answer key not found' });
    }

    const name = String(req.body?.name || items[idx].name || '').trim();
    if (!name) {
      return res.status(400).json({ error: 'Nama kunci jawaban wajib diisi' });
    }

    const keyMap = extractKeyMapFromPayload(req.body);
    const totalQuestions = Number(req.body?.total || Math.max(35, Object.keys(keyMap).length || 35));
    const optionChoices = normalizeOptionChoices(req.body?.optionChoices || req.body?.options || 'ABCDE');
    const validation = validateAnswerKey(keyMap, totalQuestions, optionChoices);
    if (!validation.valid) {
      return res.status(400).json({
        error: 'Invalid answer key',
        errors: validation.errors,
        warnings: validation.warnings,
      });
    }

    items[idx] = {
      ...items[idx],
      name,
      keyMap,
      updatedAt: new Date().toISOString(),
    };

    writeAnswerKeysStore(items);

    // Async sync to Go backend
    syncAnswerKeyToMain(items[idx]).catch(() => {});

    return res.json({ success: true, key: toAnswerKeySummary(items[idx]) });
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Failed to update answer key' });
  }
});

app.delete('/api/answer-key/:id', (req, res) => {
  const items = readAnswerKeysStore();
  const target = items.find((item) => String(item.id) === String(req.params.id));
  const next = items.filter((item) => String(item.id) !== String(req.params.id));
  if (next.length === items.length) {
    return res.status(404).json({ error: 'Answer key not found' });
  }

  writeAnswerKeysStore(next);

  // Async sync to Go backend
  if (target?.mainApiId) {
    deleteAnswerKeyFromMain(target.mainApiId).catch(() => {});
  }

  return res.json({ success: true });
});

app.post('/api/answer-key/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const totalQuestions = Number(req.body.total || 35);
    const optionChoices = normalizeOptionChoices(req.body.optionChoices || req.body.options || 'ABCDE');
    let keyObj;

    if (req.file.mimetype === 'application/json' || req.file.originalname.endsWith('.json')) {
      keyObj = JSON.parse(req.file.buffer.toString('utf-8'));
    } else {
      keyObj = parseAnswerKeyFromText(req.file.buffer.toString('utf-8'), optionChoices);
    }

    const validation = validateAnswerKey(keyObj, totalQuestions, optionChoices);
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

// --- Template Grid Endpoints ---

app.get('/api/template/current', (_req, res) => {
  const template = readStoredTemplate(templateGridPath);
  if (!template) {
    return res.json({ registered: false, template: null });
  }
  return res.json({ registered: true, template });
});

app.post('/api/template/register', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const filename = String(req.file.originalname || 'template');
    const mime = String(req.file.mimetype || '');
    const isDocx =
      mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
      filename.toLowerCase().endsWith('.docx');
    const isPdf =
      mime === 'application/pdf' ||
      filename.toLowerCase().endsWith('.pdf');

    if (!isDocx && !isPdf) {
      return res.status(400).json({ error: 'Template hanya mendukung file DOCX atau PDF.' });
    }

    const analysis = isPdf
      ? await parsePdfTemplate(req.file.buffer)
      : await parseDocxTemplate(req.file.buffer);

    const record = {
      name: filename,
      total: analysis.total,
      optionChoices: analysis.optionChoices,
      tableCount: analysis.tableCount,
      questionsPerTable: analysis.questionsPerTable,
      calibration: analysis.calibration,
      registeredAt: new Date().toISOString(),
    };

    writeStoredTemplate(templateGridPath, record);

    return res.json({
      success: true,
      template: record,
    });
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Template registration failed' });
  }
});

app.delete('/api/template/current', (_req, res) => {
  if (fs.existsSync(templateGridPath)) {
    fs.unlinkSync(templateGridPath);
  }
  return res.json({ success: true });
});

app.use((err, _req, res, _next) => {
  const message = String(err?.message || 'Request failed');
  if (message.toLowerCase().includes('unexpected end of form')) {
    return res.status(400).json({ error: 'Upload tidak lengkap. Silakan ulangi unggah file.' });
  }

  if (err?.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: 'File terlalu besar. Maksimum 10MB per file.' });
  }

  if (err?.code === 'LIMIT_FILE_COUNT') {
    return res.status(400).json({ error: 'Jumlah file melebihi batas maksimum.' });
  }

  return res.status(500).json({ error: message });
});

app.listen(PORT, () => {
  console.log(`OCR web server running at http://localhost:${PORT}`);
  // Restore answer keys from Go backend if local store is empty
  restoreAnswerKeysFromMain().catch((err) => {
    console.error('[ocr-sync] Startup restore failed:', err.message);
  });
});
