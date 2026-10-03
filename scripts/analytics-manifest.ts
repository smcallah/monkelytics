import { randomUUID } from 'node:crypto';
import { readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { generateAnalyticsHelper } from '../src/lib/analytics-codegen';
import { MANIFEST_MAX_BYTES, parseAnalyticsManifest } from '../src/lib/analytics-manifest';

function main() {
  const [command, file, ...options] = process.argv.slice(2);
  if (!['validate', 'generate', 'check'].includes(command) || !file) {
    throw new Error(
      'Usage: pnpm analytics <validate|generate|check> analytics.yaml [--website-id UUID --out helper.ts]',
    );
  }
  if (command === 'validate' && options.length)
    throw new Error('validate accepts only the manifest path');
  const args = new Map<string, string>();
  for (let i = 0; i < options.length; i += 2) {
    if (
      !['--website-id', '--out'].includes(options[i]) ||
      !options[i + 1] ||
      args.has(options[i])
    ) {
      throw new Error('Expected one --website-id UUID and one --out helper.ts');
    }
    args.set(options[i], options[i + 1]);
  }
  const input = resolve(file);
  if (statSync(input).size > MANIFEST_MAX_BYTES) throw new Error('Manifest exceeds 256 KiB');
  const manifest = parseAnalyticsManifest(readFileSync(input, 'utf8'), file);
  if (command === 'validate') {
    console.log(`${file}: valid`);
    return;
  }
  const websiteId = args.get('--website-id');
  const outputFile = args.get('--out');
  if (!websiteId || !outputFile) throw new Error('generate/check require --website-id and --out');
  const output = resolve(outputFile);
  if (!output.endsWith('.ts') || output === input)
    throw new Error('Output must be a separate .ts file');
  const generated = generateAnalyticsHelper(manifest, websiteId);
  if (command === 'check') {
    if (readFileSync(output, 'utf8').replaceAll('\r\n', '\n') !== generated) {
      throw new Error(`${output}: generated helper is out of date; run generate`);
    }
    console.log(`${output}: up to date`);
  } else {
    const temporary = `${output}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, generated, { flag: 'wx' });
      renameSync(temporary, output);
    } catch (failure) {
      try {
        unlinkSync(temporary);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          console.error(`Could not clean up temporary helper: ${temporary}`);
        }
      }
      throw failure;
    }
    console.log(`${output}: generated`);
  }
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Manifest command failed');
  process.exitCode = 1;
}
