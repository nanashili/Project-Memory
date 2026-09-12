export class LlamaContextSequenceCheckpoints {
    _checkpoints = [];
    _namedCheckpoints = new Map();
    _memoryUsage = 0;
    storeCheckpoint({ name, maxNamedCheckpoints, checkpoint, currentMaxPos }) {
        // TODO: if a named checkpoint is on the same index as the current checkpoint,
        //  reuse the same underlying checkpoint data instead of having it get duplicated
        if (this.hasCheckpoint(name, currentMaxPos))
            return;
        const existingCheckpointsCount = this._getCheckpointsCount(name);
        this._pruneOldCheckpoints(name, existingCheckpointsCount - maxNamedCheckpoints + 1);
        this._checkpoints.push([name, checkpoint]);
        this._resizeCheckpointsCount(name, 1);
        this._memoryUsage += checkpoint.size;
    }
    hasCheckpoint(name, maxPos) {
        for (let i = this._checkpoints.length - 1; i >= 0; i--) {
            const [checkpointName, checkpoint] = this._checkpoints[i];
            if (checkpointName === name && checkpoint.maxPos === maxPos)
                return true;
            if (checkpoint.maxPos < maxPos)
                break;
        }
        return false;
    }
    getLastCheckpoint(restoreIndex, contextSize) {
        if (restoreIndex <= 0)
            return null;
        for (let i = this._checkpoints.length - 1; i >= 0; i--) {
            const [, checkpoint] = this._checkpoints[i];
            if (restoreIndex >= checkpoint.minPos && checkpoint.maxPos <= contextSize)
                return checkpoint;
            else if (restoreIndex < checkpoint.minPos)
                return null;
        }
        return null;
    }
    clearAllCheckpoints() {
        for (const [, checkpoint] of this._checkpoints)
            checkpoint.dispose();
        this._checkpoints.length = 0;
        this._namedCheckpoints.clear();
        this._memoryUsage = 0;
    }
    get lastCheckpointIndex() {
        const [, checkpoint] = this._checkpoints[this._checkpoints.length - 1] ?? [];
        if (checkpoint == null)
            return -1;
        return checkpoint.maxPos;
    }
    getLastNamedCheckpointIndex(name) {
        if (this._getCheckpointsCount(name) === 0)
            return -1;
        for (let i = this._checkpoints.length - 1; i >= 0; i--) {
            const [checkpointName, checkpoint] = this._checkpoints[i];
            if (checkpointName === name)
                return checkpoint.maxPos;
        }
        return -1;
    }
    get memoryUsage() {
        return this._memoryUsage;
    }
    prepareMemoryForIncomingCheckpoint(maxMemoryUsage) {
        const [, lastCheckpoint] = this._checkpoints[this._checkpoints.length - 1] ?? [];
        if (lastCheckpoint == null)
            return;
        while (this._memoryUsage + lastCheckpoint.size > maxMemoryUsage && this._checkpoints.length > 0) {
            const [name, firstCheckpoint] = this._checkpoints.shift() ?? [];
            if (firstCheckpoint == null)
                break;
            this._memoryUsage -= firstCheckpoint.size;
            firstCheckpoint.dispose();
            this._resizeCheckpointsCount(name, -1);
        }
    }
    pruneToKeepUnderMemoryUsage(maxMemoryUsage, minCheckpointsToKeep = 1) {
        while (this._memoryUsage > maxMemoryUsage && this._checkpoints.length > minCheckpointsToKeep && this._checkpoints.length > 0) {
            const [checkpointName, checkpoint] = this._checkpoints.shift() ?? [];
            if (checkpoint == null)
                break;
            this._memoryUsage -= checkpoint.size;
            checkpoint.dispose();
            this._resizeCheckpointsCount(checkpointName, -1);
        }
    }
    /**
     * Prune checkpoints that come after the specified index (keep the specified index checkpoint)
     */
    pruneFromEndToIndex(minMaxPos) {
        while (this._checkpoints.length > 0) {
            const [name, checkpoint] = this._checkpoints.at(-1) ?? [];
            if (checkpoint == null || checkpoint.maxPos <= minMaxPos)
                break;
            this._memoryUsage -= checkpoint.size;
            checkpoint.dispose();
            this._resizeCheckpointsCount(name, -1);
            this._checkpoints.pop();
        }
    }
    _getCheckpointsCount(name) {
        return this._namedCheckpoints.get(name) ?? 0;
    }
    _resizeCheckpointsCount(name, diff) {
        const currentCount = this._getCheckpointsCount(name);
        const newCount = currentCount + diff;
        if (newCount < 0)
            throw new Error("Checkpoint count cannot be negative");
        if (newCount === 0)
            this._namedCheckpoints.delete(name);
        else
            this._namedCheckpoints.set(name, newCount);
    }
    _pruneOldCheckpoints(name, pruneCount) {
        if (pruneCount <= 0)
            return;
        for (let i = 0; i < this._checkpoints.length && pruneCount > 0; i++) {
            const [checkpointName, checkpoint] = this._checkpoints[i];
            if (checkpointName !== name)
                continue;
            this._memoryUsage -= checkpoint.size;
            checkpoint.dispose();
            this._checkpoints.splice(i, 1);
            this._resizeCheckpointsCount(name, -1);
            i--;
            pruneCount--;
        }
    }
}
//# sourceMappingURL=LlamaContextSequenceCheckpoints.js.map