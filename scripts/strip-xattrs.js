"use strict";

/**
 * electron-builder `afterPack` hook — strips macOS extended attributes
 * (notably `com.apple.provenance`) from every file inside the packaged
 * .app bundle before codesign runs. Without this, codesign on macOS 14+
 * fails with: "resource fork, Finder information, or similar detritus
 * not allowed".
 *
 * `xattr -c` / `xattr -d` can't remove `com.apple.provenance` directly
 * (it's SIP-protected), so we recreate every regular file via `ditto`,
 * which doesn't copy extended attributes when `--noextattr` is set.
 */
const { execSync } = require("node:child_process");
const path = require("node:path");

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== "darwin") return;

  const appPath = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`,
  );

  const tmpPath = `${appPath}.xattr-tmp`;

  // ditto with --norsrc --noextattr --noacl produces a copy that has
  // no resource forks, extended attributes, or ACLs — exactly what
  // codesign wants. We then swap the cleaned copy back into place.
  execSync(`ditto --norsrc --noextattr --noacl "${appPath}" "${tmpPath}"`, {
    stdio: "inherit",
  });
  execSync(`rm -rf "${appPath}"`, { stdio: "inherit" });
  execSync(`mv "${tmpPath}" "${appPath}"`, { stdio: "inherit" });

  console.log(`[strip-xattrs] cleaned extended attributes on ${appPath}`);
};
