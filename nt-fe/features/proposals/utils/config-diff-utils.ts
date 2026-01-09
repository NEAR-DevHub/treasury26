export interface ConfigDiff {
    nameChanged: boolean;
    purposeChanged: boolean;
    metadataChanged: boolean;
    oldConfig: {
        name: string | null;
        purpose: string | null;
        metadata: Record<string, any> | null;
    };
    newConfig: {
        name: string;
        purpose: string;
        metadata: Record<string, any>;
    };
    changesCount: number;
}

/**
 * Compute the difference between two configs
 */
export function computeConfigDiff(
    oldConfig: { name: string | null; purpose: string | null; metadata: Record<string, any> | null } | null,
    newConfig: { name: string; purpose: string; metadata: Record<string, any> }
): ConfigDiff {
    const nameChanged = oldConfig?.name !== newConfig.name;
    const purposeChanged = oldConfig?.purpose !== newConfig.purpose;
    const metadataChanged = JSON.stringify(oldConfig?.metadata) !== JSON.stringify(newConfig.metadata);

    let changesCount = 0;
    if (nameChanged) changesCount++;
    if (purposeChanged) changesCount++;

    if (metadataChanged) {
        const oldMetadata = oldConfig?.metadata ?? {};
        const newMetadata = newConfig.metadata ?? {};

        // Get all unique keys from both old and new metadata
        const allKeys = new Set([...Object.keys(oldMetadata), ...Object.keys(newMetadata)]);

        // Count how many keys have different values
        for (const key of allKeys) {
            if (JSON.stringify(oldMetadata[key]) !== JSON.stringify(newMetadata[key])) {
                changesCount++;
            }
        }
    }

    return {
        nameChanged,
        purposeChanged,
        metadataChanged,
        oldConfig: {
            name: oldConfig?.name ?? null,
            purpose: oldConfig?.purpose ?? null,
            metadata: oldConfig?.metadata ?? null,
        },
        newConfig,
        changesCount,
    };
}

