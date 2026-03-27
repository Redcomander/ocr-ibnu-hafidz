# Summary of Recent Updates

## Grid Detection Improvements

- Changed detection strategy to find **marked cells** (X marks) instead of fallback text OCR
- Recalibrated grid block positions for SMA IT IBNU HAFIDZ layout:
  - Q1-10 (left column)
  - Q11-20 (middle column)
  - Q21-30 (right column)
  - Q31-35 (bottom row)

## Answer Key Management

### New APIs
- `GET /api/answer-key/template?total=35` — Download blank JSON template
- `POST /api/answer-key/upload` — Upload custom answer key (JSON, CSV, or text)
- `GET /api/answer-key/current` — Check current loaded key status

### Supported Formats
- **JSON**: Direct key-value pairs
- **CSV**: `number,answer` per line
- **Text**: `number|answer` or `number:answer` format

## Current Status
- Grid detection now uses `layout-grid` method (vs text-ocr fallback)
- 25% accuracy baseline on test image (needs fine-tuning)
- Web UI includes key upload section with status display

## Next Steps for Fine-Tuning
- Auto-calibration using table-border detection
- Per-image grid alignment
- User can hover-verify detected grid positions
