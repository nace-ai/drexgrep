import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** Package version from package.json; resolves from both src/ and the bundled dist/. */
function readPackageVersion(): string {
  try {
    const url = new URL("../package.json", import.meta.url);
    const parsed = JSON.parse(readFileSync(fileURLToPath(url), "utf8")) as { version?: string };
    if (parsed.version) return parsed.version;
  } catch {
    // fall through
  }
  return "0.0.0";
}

export const PACKAGE_VERSION = readPackageVersion();

/** Attribution sent to Drex as `X-Nace-Client` and `User-Agent`. */
export const CLIENT_ID = `drexgrep/${PACKAGE_VERSION}`;
