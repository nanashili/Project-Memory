export declare function getBuildDefaults(): Promise<{
    repo: string;
    release: string;
    gpuSupport: false | "auto" | "metal" | "cuda" | "vulkan";
}>;
