import path from "path";
import fs from "fs-extra";
export async function resolvePackageJsonConfig(startDir) {
    const currentConfig = {};
    let currentDirPath = path.resolve(startDir);
    while (true) {
        applyConfig(currentConfig, await readPackageJsonConfig(path.join(currentDirPath, "package.json")));
        const parentDirPath = path.dirname(currentDirPath);
        if (parentDirPath === currentDirPath)
            break;
        currentDirPath = parentDirPath;
    }
    const npmPackageJsonPath = process.env["npm_package_json"] ?? "";
    if (npmPackageJsonPath !== "")
        applyConfig(currentConfig, await readPackageJsonConfig(npmPackageJsonPath));
    return currentConfig;
}
export function parsePackageJsonConfig(config) {
    const res = {};
    const castedConfig = config;
    if (castedConfig.nodeLlamaCppPostinstall === "auto" ||
        castedConfig.nodeLlamaCppPostinstall === "ignoreFailedBuild" ||
        castedConfig.nodeLlamaCppPostinstall === "skip")
        res.nodeLlamaCppPostinstall = castedConfig.nodeLlamaCppPostinstall;
    else
        void castedConfig.nodeLlamaCppPostinstall;
    return res;
}
async function readPackageJsonConfig(packageJsonPath) {
    try {
        if (!(await fs.pathExists(packageJsonPath)))
            return {};
        const packageJsonContent = await fs.readFile(packageJsonPath, "utf8");
        const packageJson = JSON.parse(packageJsonContent);
        const config = packageJson?.config;
        if (typeof config === "object")
            return config;
        return {};
    }
    catch (err) {
        return {};
    }
}
function applyConfig(baseConfig, newConfig) {
    for (const key of Object.keys(newConfig)) {
        if (Object.hasOwn(baseConfig, key))
            continue;
        baseConfig[key] = newConfig[key];
    }
}
//# sourceMappingURL=packageJsonConfig.js.map