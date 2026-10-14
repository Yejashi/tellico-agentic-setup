// Refuses a file write the disk has no room for, and says why.
//
// On a full disk, creating a file still succeeds and writing its contents
// does not, so OpenCode's write tool leaves an empty file behind and reports
// only "Unable to write <path>". The model cannot tell that from a broken
// tool. On 2026-10-14 a lead hit that for every write -- even one to /tmp --
// concluded its write tool had failed, and argued with itself about how to
// proceed until it fell into a repetition loop, while 0-byte files piled up
// in the repository.
//
// So before a write-type tool runs, this checks the free space on the
// filesystem that will hold the file, and when there is not enough it blocks
// the call (a throw in execute.before does that, in both OpenCode 1 and 2)
// with a message that names the cause and the fix. Blocking first also means
// no empty file is created.
//
// Allowlist-first like the other guards: a path it cannot resolve or a
// filesystem it cannot measure is let through. It blocks only below a floor
// of FLOOR bytes, or twice the size of what is being written, so it cannot
// refuse a write that would have succeeded.

import { statfsSync } from "node:fs";
import { dirname, resolve } from "node:path";

const FLOOR = 64 * 1024 * 1024;
// OpenCode 2 renamed some tools; both spellings are listed.
const WRITE_TOOLS = new Set(["write", "edit", "multiedit", "patch", "apply_patch"]);

function stringArg(args, name) {
  const value = args && args[name];
  return typeof value === "string" ? value : "";
}

function floor() {
  // Tests raise it to make a roomy disk look full.
  const override = Number(process.env.TELLICO_DISK_MIN_FREE);
  return Number.isFinite(override) && override > 0 ? override : FLOOR;
}

// Free bytes for an unprivileged user on the filesystem that would hold
// `path`, measured at its nearest existing ancestor; null when unknown.
function freeBytes(path) {
  let dir = resolve(path);
  for (let i = 0; i < 64; i++) {
    try {
      const stats = statfsSync(dir);
      return Number(stats.bavail) * Number(stats.bsize);
    } catch {
      const parent = dirname(dir);
      if (parent === dir) return null;
      dir = parent;
    }
  }
  return null;
}

function human(bytes) {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
  return `${Math.max(0, Math.round(bytes / 1024))} KiB`;
}

// The check both formats share. Throws to block the call.
function guard(tool, args) {
  if (!WRITE_TOOLS.has(tool)) return;
  const path = stringArg(args, "filePath") || stringArg(args, "path") || stringArg(args, "file_path");
  if (!path) return;
  let free;
  try {
    free = freeBytes(path);
  } catch {
    return;
  }
  if (free === null) return;
  const content = stringArg(args, "content") || stringArg(args, "newString") || stringArg(args, "new_string");
  const need = Math.max(floor(), 2 * Buffer.byteLength(content));
  if (free >= need) return;
  throw new Error(
    `[disk-guard] not written: the disk that holds ${path} has only ${human(free)} free. ` +
      "This is not a fault in the write tool or in the file -- every write to that disk will " +
      "fail until space is freed. Do not retry it as it is: free space first (build output " +
      "such as target/ directories and old temporary directories is usually the bulk), or " +
      "stop and tell the user the disk is full.",
  );
}

// OpenCode 1: a server function that returns hook objects.
export const DiskGuardPlugin = async () => {
  return {
    "tool.execute.before": async (input, output) => {
      guard((input && input.tool) || "", output && output.args);
    },
  };
};

// OpenCode 2: hooks are registered on the context.
async function setup(context) {
  const registration = await context.tool.hook("execute.before", (event) => {
    guard((event && event.tool) || "", event && event.input);
  });
  return () => registration.dispose();
}

export default {
  id: "tellico-disk-guard",
  server: DiskGuardPlugin,
  setup,
};
