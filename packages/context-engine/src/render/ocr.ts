import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/*
 * Optional OCR for scanned pages: the Windows.Media.Ocr engine through a PowerShell child process,
 * used only when the ja-JP OCR language is installed (checked once per process). Everywhere else
 * `ocrImage` answers undefined and the caller hands the picture to the client's own vision.
 */

export const OCR_TIMEOUT_MS = 20_000;

export interface OcrProcessResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** Runs a Windows PowerShell script (UTF-8 stdout) with the given environment. */
export type OcrRunner = (
  script: string,
  env: Record<string, string>,
  timeoutMs: number,
) => Promise<OcrProcessResult>;

const PRELUDE = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName System.Runtime.WindowsRuntime
[void][Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType=WindowsRuntime]
`;

const DETECT_SCRIPT = `${PRELUDE}
$found = $false
foreach ($l in [Windows.Media.Ocr.OcrEngine]::AvailableRecognizerLanguages) {
  if ($l.LanguageTag -like 'ja*') { $found = $true }
}
if ($found) { [Console]::Out.Write('ja-JP') } else { exit 3 }
`;

const OCR_SCRIPT = `${PRELUDE}
[void][Windows.Graphics.Imaging.BitmapDecoder, Windows.Foundation, ContentType=WindowsRuntime]
[void][Windows.Storage.StorageFile, Windows.Foundation, ContentType=WindowsRuntime]
$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
  $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1' })[0]
function Await($op, $type) {
  $task = $asTask.MakeGenericMethod($type).Invoke($null, @($op))
  [void]$task.Wait(-1)
  $task.Result
}
$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage([Windows.Globalization.Language]::new('ja-JP'))
if ($null -eq $engine) { exit 3 }
$file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($env:UC_OCR_IMAGE)) ([Windows.Storage.StorageFile])
$stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
$decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
$bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
$result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
[Console]::Out.Write($result.Text)
`;

const powershellRunner: OcrRunner = (script, env, timeoutMs) =>
  new Promise((resolve) => {
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      { windowsHide: true, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.stdout.setEncoding('utf8').on('data', (d: string) => (stdout += d));
    child.stderr.setEncoding('utf8').on('data', (d: string) => (stderr += d));
    child.once('error', (e) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr: String(e), timedOut });
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
  });

let runner: OcrRunner = powershellRunner;
let platform: string = process.platform;
let detected: Promise<boolean> | undefined;

/** Tests: a fake PowerShell and platform; forgets the cached detection. */
export function setOcrEnvironment(options?: { runner?: OcrRunner; platform?: string }): void {
  runner = options?.runner ?? powershellRunner;
  platform = options?.platform ?? process.platform;
  detected = undefined;
}

/** Windows with the ja-JP OCR language installed (checked once, 20 s at most). */
export function ocrAvailable(): Promise<boolean> {
  detected ??=
    platform !== 'win32'
      ? Promise.resolve(false)
      : runner(DETECT_SCRIPT, {}, OCR_TIMEOUT_MS).then(
          (r) => r.code === 0 && r.stdout.trim() === 'ja-JP',
          () => false,
        );
  return detected;
}

/** Text of a picture (JPEG / PNG bytes), or undefined when OCR is not available or finds none. */
export async function ocrImage(
  data: Uint8Array,
  ext: 'jpg' | 'png' = 'jpg',
): Promise<string | undefined> {
  if (!(await ocrAvailable())) return undefined;
  const dir = mkdtempSync(path.join(tmpdir(), 'uc-ocr-'));
  try {
    const file = path.join(dir, `page.${ext}`);
    writeFileSync(file, data);
    const r = await runner(OCR_SCRIPT, { UC_OCR_IMAGE: file }, OCR_TIMEOUT_MS);
    if (r.code !== 0 || r.timedOut) return undefined;
    const text = r.stdout.replace(/\r\n/g, '\n').trim();
    return text.length > 0 ? text : undefined;
  } catch {
    return undefined;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
