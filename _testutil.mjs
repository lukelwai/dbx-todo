// 共享工具：removeTree / runProcess / sleepSync
//
// 本机沙箱的两坑（见 dbx-plugin-dev 技能 / 项目工作记忆）：
//   1) fs.rmSync/unlinkSync/rmdirSync 被接管成"移到回收站"，目录一多就 ETIMEDOUT；
//      所以删除一律走异步 fs.promises.rm（走系统调用，不受接管影响）。
//   2) spawnSync 对任何 exe 立刻 EBUSY（异步 spawn 正常）；跑侧车只能用异步 spawn。
// 排查时务必把 error.message 打出来 —— 只写 exit=null 会让人误以为是"侧车不回话"。
import fs from "node:fs";
import { spawn } from "node:child_process";

export async function removeTree(dir) {
  try {
    await fs.promises.rm(dir, { recursive: true, force: true });
  } catch { /* 已不存在或被占用：忽略（探针目录是临时产物） */ }
}

export function runProcess(exe, args, opts = {}) {
  const { env = process.env, input = "", timeoutMs = 60000 } = opts;
  return new Promise((resolve) => {
    let out = "", err = "", settled = false;
    let proc;
    try {
      proc = spawn(exe, args || [], { env, windowsHide: true });
    } catch (e) {
      // 起不来的 exe（EBUSY / 找不到）：直接带 error 返回，让上层把 message 报出来。
      return resolve({ code: null, signal: null, out, err, error: e });
    }
    const finish = (code, signal, error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, signal, out, err, error: error || null });
    };
    if (input) {
      try { proc.stdin.write(input); } catch { /* 忽略 */ }
      try { proc.stdin.end(); } catch { /* 忽略 */ }
    }
    proc.stdout.on("data", (d) => (out += d));
    proc.stderr.on("data", (d) => (err += d));
    const timer = setTimeout(() => { try { proc.kill("SIGKILL"); } catch { /* 忽略 */ } }, timeoutMs);
    proc.on("error", (e) => finish(null, null, e));
    proc.on("close", (code, signal) => finish(code, signal, null));
  });
}

export function sleepSync(ms) {
  // 同步 sleep：用 Atomics.wait 实现，不依赖 timer，且不受沙箱 EBUSY 影响。
  const sab = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(sab, 0, 0, Math.max(0, ms | 0));
}
