// 由 cleanup.test.mjs 用子进程运行：激活插件、起一个（假）隧道、停用，然后看进程是否能自己退出。
import { activate, deactivate } from '../src/main.mjs';
import { access } from 'node:fs/promises';

const [command, pidFile, dataDir] = process.argv.slice(2);
activate({
  dataDir,
  config: { get: async () => ({ botId: '', secret: '' }) },
  tools: { register() {} },
  events: { on() {} },
  renderer: { handle() {} },
  ui: { view: { emit() {} } },
}, {
  planTunnel: async () => ({ kind: 'quick', mode: 'quick', command, args: [pidFile], publicUrl: '' }),
});
for (let i = 0; i < 200; i++) {
  if (await access(pidFile).then(() => true, () => false)) break;
  await new Promise((resolve) => setTimeout(resolve, 25));
}
deactivate();
