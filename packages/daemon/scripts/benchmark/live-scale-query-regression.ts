import { runLiveScaleQueryCli } from './live-scale-query-regression-lib';

if (import.meta.main) {
  process.exit(runLiveScaleQueryCli(process.argv.slice(2), process.env));
}
