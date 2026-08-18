#!/usr/bin/env node
/**
 * ETL command line.
 *
 *   npm run etl -- discover                    profile the on-prem Evosus database
 *   npm run etl -- extract:mssql --entity customer --table dbo.Customer --key CustomerID
 *   npm run etl -- extract:csv   --entity customer --file ./data/customers.csv --key CustomerID
 *   npm run etl -- transform     --entity customer|property|history|all
 *   npm run etl -- report
 *   npm run etl -- demo                        end-to-end run on synthetic data
 */
import { discover } from './discover.js';
import { extractMssql, extractCsv, extractCsvDir } from './extract.js';
import { transformCustomers, transformProperties, transformHistory } from './transform.js';
import { report } from './report.js';
import { runDemo } from './demo.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

const command = process.argv[2];

try {
  switch (command) {
    case 'discover':
      await discover({ deep: flag('deep'), sampleSize: Number(arg('samples') ?? 5) });
      break;

    case 'extract:mssql': {
      const entity = arg('entity'), table = arg('table'), key = arg('key');
      if (!entity || !table || !key) throw new Error('extract:mssql needs --entity, --table and --key');
      await extractMssql({
        entity, table, keyColumn: key,
        watermarkColumn: arg('watermark'),
        since: arg('since'),
        limit: arg('limit') ? Number(arg('limit')) : undefined,
      });
      break;
    }

    case 'extract:csv': {
      const key = arg('key');
      if (!key) throw new Error('extract:csv needs --key');
      const dir = arg('dir');
      if (dir) { await extractCsvDir(dir, key); break; }
      const entity = arg('entity'), file = arg('file');
      if (!entity || !file) throw new Error('extract:csv needs --entity and --file (or --dir)');
      await extractCsv({ entity, file, keyColumn: key });
      break;
    }

    case 'transform': {
      const entity = arg('entity') ?? 'all';
      const limit = arg('limit') ? Number(arg('limit')) : undefined;
      // Order matters: properties need customers, history needs both.
      if (entity === 'customer' || entity === 'all') await transformCustomers({ limit });
      if (entity === 'property' || entity === 'all') await transformProperties({ limit });
      if (entity === 'history'  || entity === 'all') await transformHistory({ limit });
      break;
    }

    case 'report':
      await report({ write: !flag('no-write') });
      break;

    case 'demo':
      await runDemo();
      break;

    default:
      console.log(`Unknown command: ${command ?? '(none)'}

  discover                     profile the on-prem Evosus database
  extract:mssql --entity E --table T --key K [--watermark COL --since DATE --limit N]
  extract:csv   --entity E --file F --key K   (or --dir D --key K)
  transform     [--entity customer|property|history|all] [--limit N]
  report        [--no-write]
  demo                         end-to-end run on synthetic data, no server needed
`);
      process.exitCode = 1;
  }
} catch (err: any) {
  console.error(`\n[etl] ${err?.message ?? err}`);
  process.exitCode = 1;
}
