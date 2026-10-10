import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
const [action, ...args] = process.argv.slice(2);
const label = "com.m4rk.capy.worker";
const file = path.join(
  os.homedir(),
  "Library",
  "LaunchAgents",
  `${label}.plist`,
);
const domain = `gui/${process.getuid()}`;
const run = (args) => {
  const r = spawnSync("launchctl", args, { stdio: "inherit" });
  if (r.status !== 0) process.exitCode = r.status ?? 1;
};
const xml = (s) =>
  s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
if (action === "status") run(["print", `${domain}/${label}`]);
else if (action === "stop") {
  run(["bootout", domain, file]);
  if (fs.existsSync(file))
    fs.writeFileSync(
      file,
      fs
        .readFileSync(file, "utf8")
        .replaceAll(
          "<key>RunAtLoad</key><true/>",
          "<key>RunAtLoad</key><false/>",
        )
        .replaceAll(
          "<key>KeepAlive</key><true/>",
          "<key>KeepAlive</key><false/>",
        ),
      { mode: 0o600 },
    );
} else if (action === "start") {
  fs.writeFileSync(
    file,
    fs
      .readFileSync(file, "utf8")
      .replaceAll("<key>RunAtLoad</key><false/>", "<key>RunAtLoad</key><true/>")
      .replaceAll(
        "<key>KeepAlive</key><false/>",
        "<key>KeepAlive</key><true/>",
      ),
    { mode: 0o600 },
  );
  run(["bootstrap", domain, file]);
} else if (action === "uninstall") {
  run(["bootout", domain, file]);
  if (fs.existsSync(file)) fs.unlinkSync(file);
} else if (action === "install") {
  const executable = args[0],
    worker = args[1],
    dataDir = args[2];
  if (
    !executable ||
    !worker ||
    !dataDir ||
    ![executable, worker, dataDir].every(path.isAbsolute)
  )
    throw Error(
      "install requires absolute executable, bundled worker file, and data directory paths",
    );
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>${label}</string><key>ProgramArguments</key><array><string>${xml(executable)}</string><string>--experimental-sqlite</string><string>${xml(worker)}</string></array><key>WorkingDirectory</key><string>${xml(path.dirname(worker))}</string><key>EnvironmentVariables</key><dict><key>CAPY_WORKER</key><string>1</string><key>CAPY_DESKTOP</key><string>1</string><key>CAPY_DATA_DIR</key><string>${xml(dataDir)}</string><key>ELECTRON_RUN_AS_NODE</key><string>1</string></dict><key>RunAtLoad</key><false/><key>KeepAlive</key><false/></dict></plist>\n`,
    { mode: 0o600 },
  );
  console.log(
    `Installed ${file}. Run worker:service start to explicitly enable it.`,
  );
} else
  throw Error(
    "Usage: worker:service install <executable> <worker> <data-dir> | start | stop | status | uninstall",
  );
