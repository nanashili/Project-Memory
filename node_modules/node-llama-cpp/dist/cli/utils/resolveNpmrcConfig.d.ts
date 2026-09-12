export declare function getCurrentNpmrcConfig(): Promise<Record<string, string>>;
export declare function getNpmrcRegistry(npmrcConfig: Record<string, string>): {
    isDefault: boolean;
    registryUrl: string;
    cleanRegistryUrl: string;
};
export type NpmConfigLayers = {
    builtin: Record<string, string>;
    global: Record<string, string>;
    user: Record<string, string>;
    project: Record<string, string>;
    env: Record<string, string>;
    paths: {
        project: string | undefined;
        user: string | undefined;
        global: string | undefined;
    };
};
