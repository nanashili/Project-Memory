import { NodeLlamaCppPostinstallBehavior } from "../../types.js";
export declare function resolvePackageJsonConfig(startDir: string): Promise<Record<string, any>>;
export declare function parsePackageJsonConfig(config: Record<string, any>): NlcPackageJsonConfig;
export type NlcPackageJsonConfig = {
    nodeLlamaCppPostinstall?: NodeLlamaCppPostinstallBehavior;
};
