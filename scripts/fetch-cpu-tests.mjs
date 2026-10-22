// Downloads the start of each opcode file of Tom Harte's 65816 SingleStepTests (MIT), in
// emulation (e) and native (n) mode. The full files are about 3 GB, so only the first
// `node scripts/fetch-cpu-tests.mjs <count>` tests of each (100 by default) are kept.
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'tests', 'fixtures', '65816');
const perOpcode = Number(process.argv[2] ?? 100);
const BASE = 'https://raw.githubusercontent.com/SingleStepTests/65816/main/v1';
/** Each test is about 700 bytes of JSON. */
const BYTES_PER_TEST = 900;

/** The complete tests at the start of a JSON array cut off mid-way. */
function completeTests(text, count) {
  const tests = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim().replace(/^\[/, '').replace(/,$/, '');
    if (!trimmed.startsWith('{')) continue;
    try {
      tests.push(JSON.parse(trimmed));
    } catch {
      break;
    }
    if (tests.length === count) break;
  }
  return tests;
}

await mkdir(dir, { recursive: true });
const files = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0')).flatMap((op) => [`${op}.e`, `${op}.n`]);
let saved = 0;
for (let i = 0; i < files.length; i += 16) {
  await Promise.all(
    files.slice(i, i + 16).map(async (name) => {
      const response = await fetch(`${BASE}/${name}.json`, { headers: { Range: `bytes=0-${perOpcode * BYTES_PER_TEST - 1}` } });
      if (!response.ok) throw new Error(`${name}: HTTP ${response.status}`);
      const tests = completeTests(await response.text(), perOpcode);
      await writeFile(join(dir, `${name}.json`), JSON.stringify(tests));
      saved += tests.length;
    }),
  );
}
console.log(`Saved ${saved} 65816 tests in tests/fixtures/65816/`);
