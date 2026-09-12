export declare function getFirstWritableDir(dirPaths: string[]): Promise<string | null>;
export declare function isPathWritableWithCache(dirPath: string): Promise<boolean>;
export declare function isPathWritable(dirPath: string): Promise<boolean>;
/**
 * Check whether a path is inside an asar when running in Electron,
 * which means that the path is not writable and inaccessible outside the Electron app.
 */
export declare function isPathInsideAsar(dirPath: string, excludeUnpacked?: boolean): boolean;
