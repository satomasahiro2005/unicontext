import { existsSync } from 'node:fs';
import path from 'node:path';
import {
  backupDatabase,
  exportJsonl,
  exportJsonlToFile,
  importJsonlFile,
  purgeSource,
  type PurgeReport,
} from '@unicontext/database';
import type { Command } from 'commander';
import { NotFoundError } from '@unicontext/core';
import { CliError } from '../errors.js';
import { printTable } from '../format/views.js';
import { action, type Harness } from '../harness.js';

const IMPORT_LABELS: Record<string, string> = {
  entity: 'エンティティ（科目・課題など）',
  sourceReference: '出典',
  fact: 'ファクト',
  conflict: '競合',
  changeEvent: '変更履歴',
  identityLink: '紐付け',
  task: 'タスク',
};

const PURGE_LABELS: [keyof PurgeReport, string][] = [
  ['rawItems', '生データ'],
  ['rawBlobs', '添付データ'],
  ['sourceReferences', '出典'],
  ['facts', 'ファクト'],
  ['entities', 'エンティティ'],
  ['tasks', 'タスク'],
  ['conflicts', '競合'],
  ['identityLinks', '紐付け'],
  ['changeEvents', '変更履歴'],
];

export function registerDataCommands(program: Command, h: Harness): void {
  program
    .command('backup')
    .description(
      'データベースのバックアップを作る（秘密情報は含まない） / Back up the database (no secrets)',
    )
    .option(
      '--dir <dir>',
      '保存先ディレクトリ（既定はデータ保存先のbackups） / destination directory',
    )
    .action(
      action<{ dir?: string }>(h, async (ctx, { opts }) => {
        const rt = await ctx.runtime();
        const destination = opts.dir ? path.resolve(opts.dir) : rt.paths.backups;
        const result = await backupDatabase(rt.uc.db, destination, { now: ctx.now() });
        if (ctx.json) {
          ctx.printJson(result, { local: true });
          return;
        }
        ctx.out(ctx.style.green(`バックアップを作成しました: ${result.directory}`));
        ctx.out(`  データベース: ${result.databaseFile}`);
        ctx.out(`  紐付け情報: ${result.mappingsFile}`);
        ctx.out(`  メタデータ: ${result.metadataFile}`);
        ctx.out(ctx.style.dim('トークンやCookieなどの秘密情報は含まれていません'));
      }),
    );

  program
    .command('export')
    .description('正規化データをJSONLで書き出す / Export the canonical model as JSONL')
    .argument('[file]', '出力ファイル（省略または-で標準出力） / output file, or - for stdout')
    .action(
      action(h, async (ctx, { args }) => {
        const target = typeof args[0] === 'string' ? args[0] : undefined;
        const rt = await ctx.runtime();
        if (!target || target === '-') {
          // stdout carries only the JSONL stream
          for (const line of exportJsonl(rt.uc.db, { now: ctx.now() }))
            ctx.deps.stdout(`${line}\n`);
          return;
        }
        const file = path.resolve(target);
        const records = exportJsonlToFile(rt.uc.db, file, { now: ctx.now() });
        if (ctx.json) ctx.printJson({ file, records }, { local: true });
        else ctx.out(ctx.style.green(`${records}件を書き出しました: ${file}`));
      }),
    );

  program
    .command('import')
    .description('JSONLを取り込む（同じIDは上書き） / Import JSONL (rows are merged by id)')
    .argument('<file>', '取り込むファイル / JSONL file')
    .option('--strict', '不正な行があれば全体を中止する / abort on the first invalid line')
    .action(
      action<{ strict?: boolean }>(h, async (ctx, { args, opts }) => {
        const file = path.resolve(String(args[0]));
        if (!existsSync(file))
          throw new CliError(
            `ファイルが見つかりません: ${file}`,
            1,
            '「unicontext export <ファイル>」で作ったJSONLを指定してください',
          );
        const rt = await ctx.runtime();
        const report = await importJsonlFile(rt.uc.db, file, {
          ...(opts.strict ? { strict: true } : {}),
          clock: rt.uc.clock,
        });
        rt.uc.identity.invalidate();
        if (ctx.json) {
          ctx.printJson(report);
          return report.errors.length > 0 ? 1 : 0;
        }
        const total = Object.values(report.imported).reduce((a, b) => a + b, 0);
        ctx.out(ctx.style.green(`${total}件を取り込みました: ${file}`));
        printTable(
          ctx,
          [
            { header: '種類', value: ([k]: [string, number]) => IMPORT_LABELS[k] ?? k },
            { header: '件数', value: ([, n]: [string, number]) => String(n), align: 'right' },
          ],
          Object.entries(report.imported),
        );
        if (report.errors.length > 0) {
          ctx.err(`取り込めない行が${report.errors.length}件ありました`);
          for (const e of report.errors.slice(0, 20))
            ctx.err(`  ${e.line}行目: ${ctx.text(e.message)}`);
          if (report.errors.length > 20) ctx.err(`  ほか${report.errors.length - 20}件`);
          ctx.err('「--strict」を付けると不正な行で全体を中止します');
          return 1;
        }
        return 0;
      }),
    );

  const purge = program
    .command('purge')
    .description('ソース単位でデータを完全に削除する / Delete everything that came from a source');

  purge
    .command('source')
    .description('1つのソースのデータをすべて削除する / Delete all data of one source')
    .argument('<id>', 'ソースID / source id')
    .option('--yes', '確認の質問を省略する / skip the y/N question')
    .action(
      action<{ yes?: boolean }>(h, async (ctx, { args, opts }) => {
        const sourceId = String(args[0]);
        ctx.assertCanConfirm(opts.yes);
        const rt = await ctx.runtime();
        const raw = rt.uc.sync.stores.raw;
        if (!rt.sourceInfo.has(sourceId) && !raw.getSource(sourceId))
          throw new NotFoundError(`source ${sourceId}`);
        const daemon = await ctx.daemon();
        if (daemon)
          ctx.err(
            '警告: デーモンが起動中です。SQLiteが排他制御するためこのまま削除できますが、同期の実行中と重なると失敗することがあります。確実にするには先に「unicontext daemon stop」を実行してください',
          );
        const items = raw.list({ sourceId, includeDeleted: true }).length;
        const ok = await ctx.confirmAction(
          `ソース「${sourceId}」から取り込んだデータ（生データ${items}件と、そこから作られたすべての情報）を完全に削除します。元に戻せません。続行しますか？`,
          opts.yes,
        );
        if (!ok) {
          ctx.err('キャンセルしました（何も削除していません）');
          return 1;
        }
        const report = purgeSource(rt.uc.db, sourceId);
        rt.uc.identity.invalidate();
        if (ctx.json) {
          ctx.printJson(report);
          return 0;
        }
        ctx.out(ctx.style.green(`ソース「${sourceId}」のデータを削除しました`));
        printTable(
          ctx,
          [
            { header: '種類', value: ([label]: [string, number]) => label },
            { header: '件数', value: ([, n]: [string, number]) => String(n), align: 'right' },
          ],
          PURGE_LABELS.map(([key, label]): [string, number] => [label, report[key] as number]),
        );
        return 0;
      }),
    );
}
