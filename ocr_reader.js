const fs = require('fs');
const path = require('path');
const { loadAnswerKey, scanBuffer } = require('./lib/ocr-core');

function parseArgs(argv) {
  const args = {
    image: null,
    key: 'answer_key.json',
    total: 35,
    lang: 'eng',
  };

  if (!argv[2]) {
    throw new Error('Usage: node ocr_reader.js <image-path> [--key answer_key.json] [--total 35] [--lang eng]');
  }

  args.image = argv[2];

  for (let i = 3; i < argv.length; i += 1) {
    const token = argv[i];
    const next = argv[i + 1];

    if (token === '--key' && next) {
      args.key = next;
      i += 1;
    } else if (token === '--total' && next) {
      args.total = Number(next);
      i += 1;
    } else if (token === '--lang' && next) {
      args.lang = next;
      i += 1;
    }
  }

  return args;
}

function printResults(scan) {
  console.log(`=== METHOD ===\n${scan.method || 'unknown'}`);

  console.log('=== OCR RAW TEXT ===');
  console.log(scan.rawText || '(empty)');

  console.log('\n=== PARSED ANSWERS ===');
  const entries = Object.entries(scan.parsedAnswers);
  if (entries.length === 0) {
    console.log('No answers detected.');
  } else {
    entries.forEach(([qn, ans]) => {
      console.log(`${String(qn).padStart(2, ' ')}. ${ans}`);
    });
  }

  const duplicateEntries = Object.entries(scan.duplicates || {});
  if (duplicateEntries.length > 0) {
    console.log('\n=== DUPLICATE/CONFLICTED QUESTIONS ===');
    duplicateEntries.forEach(([qn, variants]) => {
      console.log(`${qn}: ${variants.join(', ')}`);
    });
  }

  if ((scan.missing || []).length > 0) {
    console.log('\n=== MISSING QUESTIONS ===');
    console.log(scan.missing.join(', '));
  }

  if (scan.score) {
    console.log('\n=== SCORE VS KEY ===');
    console.log(`Correct: ${scan.score.correct}/${scan.score.total}`);
    console.log(`Wrong: ${scan.score.wrong}/${scan.score.total}`);
    console.log(`Score: ${scan.score.score.toFixed(2)}%`);
  }
}

async function main() {
  const args = parseArgs(process.argv);
  const imagePath = path.resolve(args.image);
  const keyPath = path.resolve(args.key);

  if (!fs.existsSync(imagePath)) {
    throw new Error(`Image not found: ${imagePath}`);
  }

  const keyMap = fs.existsSync(keyPath) ? loadAnswerKey(keyPath) : null;
  const scan = await scanBuffer({
    fileBuffer: fs.readFileSync(imagePath),
    keyMap,
    total: args.total,
    lang: args.lang,
  });

  printResults(scan);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
