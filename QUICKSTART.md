# Quick Start Guide - v2 Features

## 1. Access the Web UI
- Open: http://localhost:3099
- All 3 sections visible: Key Management, Single Upload, Bulk Upload

## 2. Answer Key Management (NEW)

### Download Template
1. Click "Download Template" button
2. Saves `answer_key_template_35.json` to your computer
3. Fill in your answers for questions 1-35
4. Formats accepted: A, B, C, D, E only

### Upload Custom Key
1. Prepare your key file (JSON/CSV/text format)
2. Click file input and select your key
3. Click "Upload Key" button
4. Status displays: ✓ Key Loaded with count and preview

### Supported Key Formats
- **JSON**: `{"1": "C", "2": "B", ...}`
- **CSV**: Each line: `1,C` or `1|C`
- **Text**: Comma/pipe/colon separated

## 3. Improved Grid Detection

### What Changed
- Grid detector is recalibrated for your sheet layout
- Now detects marked cells (X marks) directly
- Falls back to text OCR for non-grid documents

### Testing
1. Upload `IMG_20260327_170317.jpg` as single image
2. Check "Method" field: should show `layout-grid`
3. Detectd answers will show per question
4. Scores calculated against current answer key

## 4. Bulk Upload
- Upload 30+ images at once
- See per-file method, right/wrong counts
- Aggregate summary at top
- Export ready in next version

## Troubleshooting

If grid detection is poor:
- Clear browser cache (Ctrl+F5)
- Re-upload application files
- Check image is straight/clear
- Try calibration guide (CALIBRATION.md)
