import { parentPort, workerData } from 'node:worker_threads';
import WordExtractor from 'word-extractor';
import yauzl from 'yauzl';

// Enumerate the archive before extraction. yauzl also checks actual inflated
// lengths against these declarations while the extractor reads each stream.
function checkArchive(bytes) {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(bytes, { lazyEntries: true }, (error, zip) => {
      if (error) { reject(error); return; }
      let total = 0;
      let count = 0;
      const names = new Set();
      zip.on('error', reject);
      zip.on('end', resolve);
      zip.on('entry', (entry) => {
        total += entry.uncompressedSize;
        count += 1;
        if (total > 8 * 1024 * 1024 || count > 256 || names.has(entry.fileName) || (entry.generalPurposeBitFlag & 1)) {
          zip.close();
          reject(new Error('archive_bounds'));
          return;
        }
        names.add(entry.fileName);
        zip.readEntry();
      });
      zip.readEntry();
    });
  });
}

try {
  const bytes = Buffer.from(workerData.bytes);
  if (workerData.docx) await checkArchive(bytes);
  const document = await new WordExtractor().extract(bytes);
  const text = [document.getBody(), document.getHeaders(), document.getFootnotes(), document.getEndnotes(), document.getTextboxes()].filter(Boolean).join('\n').trim();
  if (!text || text.length > 60000) throw new Error('text_bounds');
  parentPort.postMessage({ text });
} catch {
  // Parser messages can contain source text: never forward or log them.
  parentPort.postMessage({ error: true });
}
