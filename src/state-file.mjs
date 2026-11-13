import { chmod, copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export async function backupUnreadable(file, now = Date.now()) {
  const dest = `${file}.corrupt-${now}`;
  await copyFile(file, dest);
  return dest;
}

export async function readStateFile(file, now = Date.now()) {
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return { missing: true };
    let backup = null;
    try { backup = await backupUnreadable(file, now); } catch { /* keep the original error */ }
    return { unreadable: true, error, backup };
  }
  try {
    return { json: JSON.parse(text) };
  } catch (error) {
    let backup = null;
    try { backup = await backupUnreadable(file, now); } catch { /* original file stays in place */ }
    return { corrupt: true, error, backup };
  }
}

export async function writeStateFile(file, value) {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(tmp, file);
  await chmod(file, 0o600);
}
