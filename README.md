# Ibnu Hafidz OCR Service

This tool provides an Optical Character Recognition (OCR) service tailored for reading photos of multiple-choice answer sheets (specifically formatted for SMA IT IBNU HAFIDZ exams, questions 1-35). It can extract answers and compare them against a provided answer key to calculate scores.

It includes a Web UI with the following features:
- Single image upload
- Bulk upload (multiple images)
- Right/wrong counters per file
- Aggregated right/wrong counters across all files

## Setup

```bash
cd "d:\Dev Area\ibnu-hafidz-ocr-service"
npm install
```

## Running the Application

### Start the Web UI and API
```bash
npm start
```
The Web UI will be available at: http://localhost:3099

### Command-Line Usage

You can also run the OCR reader directly from the CLI:
```bash
node ocr_reader.js "path-to-image.jpg"
```

With optional arguments for answer key comparison:
```bash
node ocr_reader.js "path-to-image.jpg" --key answer_key.json --total 35 --lang eng
```

## Output Features

### CLI Output
- Raw OCR text
- Parsed answers by question number
- Duplicate/conflicting question entries
- Missing question numbers
- Accuracy against the answer key file

### Web UI Output
- Single scan result with Correct, Wrong, and Score metrics
- Bulk table displaying per-file Correct/Wrong/Score
- Summary totals across all uploaded files
- Detection method used per file (`layout-grid`, `text-ocr`, or `no-reliable-detection`)

## Answer Key Configuration

The `answer_key.json` file contains the correct answers mapping.
- Questions 1-35 with choices A, B, C, or D.

## Best Practices for Scanning

The scanner supports the SMA IT IBNU HAFIDZ answer-sheet layout by detecting marked cells in the grid directly. For best results:
- Use clear, high-resolution photos.
- Ensure the paper is upright and not tilted.
- Avoid glare and shadows on the paper.
- Crop the image tightly around the answer list grid.

## Deployment Guide (Netlify + External API)

This repository is designed for a split deployment architecture:
- **Frontend**: Static app on Netlify (from `public/`)
- **API Server**: Separate Node.js host

### 1. Netlify Frontend Configuration
- Connect this repository to Netlify.
- Build command: `none`
- Publish directory: `public`
- The `netlify.toml` file is already configured.

### 2. Pointing Frontend to API URL
Edit `public/config.js` to set your API endpoint:
```js
window.OCR_APP_CONFIG = {
	apiBaseUrl: 'https://your-api-domain.example.com',
};
```
*Note: For local development, keep `apiBaseUrl` empty (`''`) to use the same-origin `/api`.*

### 3. API Deployment
CORS is already enabled in `server.js` allowing the Netlify domain to communicate with the API.

#### Free API Hosting Recommendation
For this Node.js workload with native dependencies (Express + Sharp + Tesseract), [Render Web Service](https://render.com/) (free tier) is recommended.

**Important Deployment Notes:**
- Free tier services may sleep when idle, causing the first request to be slow.
- Local file writes (like modifications to `answer_key.json` via UI) may reset after redeploy/restart due to ephemeral filesystems. Consider migrating to a database or object storage for persistent key management in a production environment.# ocr-ibnu-hafidz
