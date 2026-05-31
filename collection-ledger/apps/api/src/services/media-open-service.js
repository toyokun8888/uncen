"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const {
  isPathUnderRoots,
  normalizeWindowsPath,
  resolveAllowedMediaRoots,
} = require("../utils/path-guard");

const EXPLORER_EXE = "C:\\Windows\\explorer.exe";
const MPC_BE_ALIAS_NAME = "mpc-be.exe";

function assertMediaPathAllowed(targetPath) {
  const normalized = normalizeWindowsPath(targetPath);
  if (!normalized) {
    throw new Error("path_empty");
  }
  if (!isPathUnderRoots(normalized, resolveAllowedMediaRoots())) {
    throw new Error("path_not_allowed");
  }
  return normalized;
}

async function openFolder(targetPath) {
  const normalized = assertMediaPathAllowed(targetPath);
  const folderPath = fs.existsSync(normalized) && fs.statSync(normalized).isDirectory()
    ? normalized
    : path.dirname(normalized);

  if (!isPathUnderRoots(folderPath, resolveAllowedMediaRoots())) {
    throw new Error("folder_not_allowed");
  }
  if (!fs.existsSync(folderPath)) {
    throw new Error("folder_not_exists");
  }

  await launchDetached(EXPLORER_EXE, [folderPath], { visible: true });
}

async function openFile(targetPath) {
  const normalized = assertMediaPathAllowed(targetPath);
  if (!fs.existsSync(normalized)) {
    throw new Error("file_not_exists");
  }

  const launchTemplate = String(process.env.MPC_BE_LAUNCH_TEMPLATE || "").trim();
  const useLaunchTemplate = String(process.env.MPC_BE_USE_LAUNCH_TEMPLATE || "false").toLowerCase() === "true";
  const mpcPath = String(process.env.MPC_BE_PATH || "").trim();
  const mpcExecutable = resolveMpcBeExecutable(mpcPath);

  if (useLaunchTemplate && launchTemplate) {
    const quotedPath = quoteCmdArg(normalized);
    const command = launchTemplate.replaceAll('"{file}"', quotedPath).replaceAll("{file}", quotedPath);
    await launchDetached("cmd.exe", ["/d", "/s", "/c", command]);
    return;
  }

  if (mpcPath || mpcExecutable) {
    if (!mpcExecutable) {
      throw new Error("mpc_be_not_exists");
    }
    await launchMpcViaExplorerLauncher(mpcExecutable, normalized);
    return;
  }

  await launchWindowsStart(["explorer.exe", normalized]);
}

function quoteCmdArg(value) {
  return `"${String(value).replace(/"/g, '\\"')}"`;
}

function launchWindowsStart(commandAndArgs) {
  const [command, ...args] = commandAndArgs;
  const line = ["start", '""', quoteCmdArg(command), ...args.map(quoteCmdArg)].join(" ");
  return launchAndWait("cmd.exe", ["/d", "/s", "/c", line], 2500);
}

function resolveMpcBeExecutable(configuredPath) {
  const normalizedConfiguredPath = configuredPath ? normalizeWindowsPath(configuredPath) : "";
  const aliasPath = resolveWindowsAppAlias(MPC_BE_ALIAS_NAME);

  if (aliasPath && launcherPathExists(aliasPath)) {
    return aliasPath;
  }
  if (
    normalizedConfiguredPath &&
    fs.existsSync(normalizedConfiguredPath) &&
    !isWindowsAppsPackagePath(normalizedConfiguredPath)
  ) {
    return normalizedConfiguredPath;
  }
  return null;
}

function resolveWindowsAppAlias(exeName) {
  const localAppData =
    process.env.LOCALAPPDATA ||
    (process.env.USERPROFILE ? path.join(process.env.USERPROFILE, "AppData", "Local") : "");
  if (!localAppData) return "";
  return path.join(localAppData, "Microsoft", "WindowsApps", exeName);
}

function launcherPathExists(targetPath) {
  try {
    fs.lstatSync(targetPath);
    return true;
  } catch {
    return false;
  }
}

function isWindowsAppsPackagePath(targetPath) {
  return normalizeWindowsPath(targetPath).toLowerCase().includes("\\program files\\windowsapps\\");
}

async function launchMpcViaExplorerLauncher(executablePath, mediaPath) {
  const baseName = `collection-ledger-open-${process.pid}-${Date.now()}`;
  const scriptPath = path.join(os.tmpdir(), `${baseName}.ps1`);
  const commandPath = path.join(os.tmpdir(), `${baseName}.cmd`);
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `$FilePath = ${quotePowerShellSingleString(executablePath)}`,
    `$MediaPath = ${quotePowerShellSingleString(mediaPath)}`,
    'Start-Process -FilePath $FilePath -ArgumentList (\'"\' + $MediaPath + \'"\')',
    "",
  ].join("\r\n");
  const command = [
    "@echo off",
    `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "${commandPathForBatch(scriptPath)}"`,
    "",
  ].join("\r\n");

  fs.writeFileSync(scriptPath, `\ufeff${script}`, "utf8");
  fs.writeFileSync(commandPath, command, "utf8");
  try {
    await launchDetached(EXPLORER_EXE, [commandPath], { visible: true });
  } finally {
    setTimeout(() => cleanupLauncherFiles([scriptPath, commandPath]), 30000);
  }
}

function quotePowerShellSingleString(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function commandPathForBatch(value) {
  return String(value).replace(/%/g, "%%");
}

function cleanupLauncherFiles(filePaths) {
  for (const filePath of filePaths) {
    try {
      fs.unlinkSync(filePath);
    } catch {
      // Ignore cleanup errors for one-shot launcher files.
    }
  }
}

function launchAndWait(command, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      detached: false,
      stdio: "ignore",
      windowsHide: true,
    });
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(() => finish(), timeoutMs);
    child.once("error", (error) => finish(error));
    child.once("close", (code) => {
      if (code && code !== 0) {
        finish(new Error(`launch_failed:${code}`));
        return;
      }
      finish();
    });
  });
}

function launchDetached(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      detached: true,
      stdio: "ignore",
      windowsHide: options.visible ? false : true,
      shell: false,
    });
    let settled = false;
    const settleResolve = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    const settleReject = (error) => {
      if (settled) return;
      settled = true;
      reject(error instanceof Error ? error : new Error(String(error)));
    };

    child.once("error", settleReject);
    child.unref();
    setTimeout(settleResolve, 350);
  });
}

module.exports = {
  openFile,
  openFolder,
};
