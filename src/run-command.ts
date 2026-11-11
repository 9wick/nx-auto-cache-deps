// cross-spawn は Windows の .cmd と引数の quoting を扱う。プロセス全体を fspy の子として起動する。
import spawn from 'cross-spawn';
import { constants } from 'node:os';

const [command, ...args] = process.argv.slice(2);
if (command === undefined) throw new Error('nx-auto-cache-deps: missing command');
const child = spawn(command, args, { stdio: 'inherit' });
child.once('error', error => {
  process.stderr.write(`nx-auto-cache-deps: ${error.message}\n`);
  process.exitCode = 1;
});
child.once('exit', (code, signal) => {
  process.exitCode = code ?? 128 + (Object.entries(constants.signals).find(([name]) => name === signal)?.[1] ?? 1);
});
