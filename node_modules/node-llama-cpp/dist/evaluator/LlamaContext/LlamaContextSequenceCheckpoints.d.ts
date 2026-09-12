import { AddonContextSequenceCheckpoint } from "../../bindings/AddonTypes.js";
export declare class LlamaContextSequenceCheckpoints {
    private _checkpoints;
    private _namedCheckpoints;
    private _memoryUsage;
    storeCheckpoint({ name, maxNamedCheckpoints, checkpoint, currentMaxPos }: {
        name: string | undefined;
        maxNamedCheckpoints: number;
        checkpoint: AddonContextSequenceCheckpoint;
        currentMaxPos: number;
    }): void;
    hasCheckpoint(name: string | undefined, maxPos: number): boolean;
    getLastCheckpoint(restoreIndex: number, contextSize: number): AddonContextSequenceCheckpoint | null;
    clearAllCheckpoints(): void;
    get lastCheckpointIndex(): number;
    getLastNamedCheckpointIndex(name: string | undefined): number;
    get memoryUsage(): number;
    prepareMemoryForIncomingCheckpoint(maxMemoryUsage: number): void;
    pruneToKeepUnderMemoryUsage(maxMemoryUsage: number, minCheckpointsToKeep?: number): void;
    /**
     * Prune checkpoints that come after the specified index (keep the specified index checkpoint)
     */
    pruneFromEndToIndex(minMaxPos: number): void;
    private _getCheckpointsCount;
    private _resizeCheckpointsCount;
    private _pruneOldCheckpoints;
}
