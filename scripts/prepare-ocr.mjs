import { mkdir, copyFile, readdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
const require = createRequire(import.meta.url);
const target = new URL('../public/ocr/v1/', import.meta.url);
await mkdir(target, { recursive: true });
const core = dirname(require.resolve('tesseract.js-core/package.json'));
for (const name of await readdir(core)) {
  if (name.endsWith('.wasm') || name.endsWith('.wasm.js')) await copyFile(join(core, name), new URL(name, target));
}
await copyFile(require.resolve('tesseract.js/dist/worker.min.js'), new URL('worker.min.js', target));
const language = dirname(require.resolve('@tesseract.js-data/eng/package.json'));
await copyFile(join(language, '4.0.0_best_int/eng.traineddata.gz'), new URL('eng.traineddata.gz', target));
await writeFile(new URL('versions.json', target), JSON.stringify({ tesseract: '7.0.0', core: '7.0.0', english: '1.0.0' }));
await copyFile(join(core, 'LICENSE'), new URL('TESSERACT-CORE-LICENSE.txt', target));
await writeFile(new URL('NOTICE.txt', target), 'Tesseract.js and Tesseract.js-core: Apache-2.0. English traineddata: Apache-2.0. See https://github.com/naptha/tesseract.js and https://github.com/tesseract-ocr/tessdata_best.\n');
console.log('Prepared same-origin OCR assets in public/ocr/v1');
