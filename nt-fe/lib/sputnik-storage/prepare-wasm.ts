/**
 * WASM preprocessor for NEAR contracts.
 * Ported from https://github.com/petersalomonsen/quickjs-rust-near/blob/main/localjstestenv/prepare-wasm.js
 *
 * Matches nearcore's preprocessing: replaces internal memory with imported memory,
 * removes memory exports, so the host (our mock env) controls the memory.
 */

function encodeLEB128(value: number): Uint8Array {
    const result: number[] = [];
    do {
        let byte = value & 0x7f;
        value >>>= 7;
        if (value !== 0) byte |= 0x80;
        result.push(byte);
    } while (value !== 0);
    return new Uint8Array(result);
}

function encodeString(value: string): Uint8Array {
    const encoded = new TextEncoder().encode(value);
    const lenBytes = encodeLEB128(encoded.length);
    const out = new Uint8Array(lenBytes.length + encoded.length);
    out.set(lenBytes);
    out.set(encoded, lenBytes.length);
    return out;
}

function concat(...arrays: Uint8Array[]): Uint8Array {
    const totalLen = arrays.reduce((sum, a) => sum + a.length, 0);
    const out = new Uint8Array(totalLen);
    let offset = 0;
    for (const a of arrays) {
        out.set(a, offset);
        offset += a.length;
    }
    return out;
}

export function prepareWASM(inputBytes: Uint8Array): Uint8Array {
    const inputView = new DataView(
        inputBytes.buffer,
        inputBytes.byteOffset,
        inputBytes.byteLength,
    );
    const parts: Uint8Array[] = [];

    const magic = new TextDecoder().decode(inputBytes.slice(0, 4));
    if (magic !== "\0asm") throw new Error("Invalid magic number");

    const version = inputView.getUint32(4, true);
    if (version !== 1) throw new Error("Invalid version: " + version);

    let offset = 8;
    parts.push(inputBytes.slice(0, offset));

    function decodeLEB128(): number {
        let result = 0;
        let shift = 0;
        let byte: number;
        do {
            byte = inputBytes[offset++];
            result |= (byte & 0x7f) << shift;
            shift += 7;
        } while (byte & 0x80);
        return result;
    }

    function decodeLimits() {
        const flags = inputBytes[offset++];
        const hasMax = flags & 0x1;
        const initial = decodeLEB128();
        const max = hasMax ? decodeLEB128() : null;
        return { initial, max };
    }

    function decodeString(): string {
        const length = decodeLEB128();
        const result = new TextDecoder().decode(
            inputBytes.slice(offset, offset + length),
        );
        offset += length;
        return result;
    }

    do {
        const sectionStart = offset;
        const sectionId = inputView.getUint8(offset);
        offset++;
        const sectionSize = decodeLEB128();
        const sectionEnd = offset + sectionSize;

        if (sectionId === 5) {
            // Memory section - make empty, use imported memory only
            parts.push(new Uint8Array([5, 1, 0]));
        } else if (sectionId === 2) {
            // Import section - remove memory imports, add our own
            const sectionParts: Uint8Array[] = [];
            const numImports = decodeLEB128();

            for (let i = 0; i < numImports; i++) {
                const importStart = offset;
                decodeString(); // module
                decodeString(); // field
                const kind = inputView.getUint8(offset);
                offset++;

                let skipImport = false;
                switch (kind) {
                    case 0:
                        decodeLEB128(); // function index
                        break;
                    case 1:
                        offset++; // table type
                        decodeLimits();
                        break;
                    case 2:
                        decodeLimits(); // memory limits
                        skipImport = true; // remove existing memory import
                        break;
                    case 3:
                        offset++; // global type
                        offset++; // mutability
                        break;
                    default:
                        throw new Error("Invalid import kind: " + kind);
                }

                if (!skipImport) {
                    sectionParts.push(inputBytes.slice(importStart, offset));
                }
            }

            // Add our env.memory import
            const importMemory = concat(
                encodeString("env"),
                encodeString("memory"),
                new Uint8Array([2, 0]), // Memory import, no max
                encodeLEB128(1), // initial 1 page
            );
            sectionParts.push(importMemory);

            const numImportsEncoded = encodeLEB128(sectionParts.length);
            const sectionData = concat(numImportsEncoded, ...sectionParts);
            const sectionSizeEncoded = encodeLEB128(sectionData.length);

            parts.push(
                concat(new Uint8Array([2]), sectionSizeEncoded, sectionData),
            );
        } else if (sectionId === 7) {
            // Export section - remove memory exports
            const sectionParts: Uint8Array[] = [];
            const numExports = decodeLEB128();

            for (let i = 0; i < numExports; i++) {
                const exportStart = offset;
                decodeString(); // name
                const kind = inputView.getUint8(offset);
                offset++;
                decodeLEB128(); // index

                if (kind !== 2) {
                    // Keep all exports except memory
                    sectionParts.push(inputBytes.slice(exportStart, offset));
                }
            }

            const numExportsEncoded = encodeLEB128(sectionParts.length);
            const sectionData = concat(numExportsEncoded, ...sectionParts);
            const sectionSizeEncoded = encodeLEB128(sectionData.length);

            parts.push(
                concat(new Uint8Array([7]), sectionSizeEncoded, sectionData),
            );
        } else {
            parts.push(inputBytes.slice(sectionStart, sectionEnd));
        }

        offset = sectionEnd;
    } while (offset < inputBytes.length);

    return concat(...parts);
}
