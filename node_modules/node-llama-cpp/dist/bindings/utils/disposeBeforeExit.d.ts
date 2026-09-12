export declare function registerDisposeBeforeExit(ref: DisposableWeakRef): void;
export declare function unregisterDisposeBeforeExit(ref: DisposableWeakRef): void;
type DisposableWeakRef = WeakRef<{
    [Symbol.dispose](): void;
} | {
    [Symbol.asyncDispose](): Promise<void>;
}>;
export {};
