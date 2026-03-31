import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const cwd = process.cwd();

const runGit = (args) => {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
};

const fail = (message) => {
  console.error(`Security check failed: ${message}`);
  process.exit(1);
};

const trackedFiles = (() => {
  try {
    const output = runGit(["ls-files"]);
    return output ? output.split(/\r?\n/).filter(Boolean) : [];
  } catch {
    return [];
  }
})();

const forbiddenTrackedPatterns = [/^\.env$/i, /^\.env\./i, /^data\//i];
for (const file of trackedFiles) {
  if (forbiddenTrackedPatterns.some((pattern) => pattern.test(file))) {
    fail(`forbidden tracked file detected: ${file}`);
  }
}

const filesToScan = trackedFiles.filter((file) => {
  const basename = path.basename(file).toLowerCase();
  return !["package-lock.json"].includes(basename);
});

const secretPatterns = [
  { name: "PRIVATE_KEY assignment", regex: /PRIVATE_KEY\s*=\s*0x[a-fA-F0-9]{64}/ },
  { name: "POLY_API_SECRET assignment", regex: /POLY_API_SECRET\s*=\s*[^\s]+/ },
  { name: "POLY_API_KEY assignment", regex: /POLY_API_KEY\s*=\s*[^\s]+/ },
  { name: "POLY_API_PASSPHRASE assignment", regex: /POLY_API_PASSPHRASE\s*=\s*[^\s]+/ },
  { name: "raw 64-byte hex private key", regex: /\b0x[a-fA-F0-9]{64}\b/ },
];

for (const relativeFile of filesToScan) {
  const absoluteFile = path.resolve(cwd, relativeFile);
  if (!existsSync(absoluteFile)) {
    continue;
  }

  const content = readFileSync(absoluteFile, "utf8");
  for (const pattern of secretPatterns) {
    if (pattern.regex.test(content)) {
      fail(`${pattern.name} found in tracked file ${relativeFile}`);
    }
  }
}

console.log("Security check passed.");
