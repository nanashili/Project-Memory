export declare function getTempDir(helperTempDirs?: string[]): Promise<FsPathHandle | undefined>;
export declare class FsPathHandle {
    readonly path: string;
    private _finalizationRegistry;
    private _disposed;
    constructor(dirPath: string);
    dispose(): Promise<void>;
    [Symbol.asyncDispose](): Promise<void>;
    [Symbol.dispose](): void;
}
