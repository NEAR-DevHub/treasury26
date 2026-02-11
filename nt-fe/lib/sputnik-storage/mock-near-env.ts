/**
 * Mock NEAR environment for running sputnik-dao WASM locally.
 * Ported from https://github.com/petersalomonsen/quickjs-rust-near/blob/main/localjstestenv/wasm-near-environment.js
 *
 * Tracks all storage writes so we can measure storage_usage() deltas
 * to estimate on-chain storage costs per proposal/vote.
 */

export class MockNearEnv {
    storage: Record<string, Uint8Array> = {};
    registers: Record<string, Uint8Array> = {};
    memory!: WebAssembly.Memory;
    latestReturnValue = "";

    private _args = "{}";
    private _currentAccountId = "test.sputnik-dao.near";
    private _signerAccountId = "council.near";
    private _predecessorAccountId = "council.near";
    private _attachedDeposit = 0n;
    _logs: string[] = [];

    // --- Setup helpers ---

    setWasmMemory(mem: WebAssembly.Memory) {
        this.memory = mem;
    }

    setArgs(args: unknown) {
        this._args = JSON.stringify(args);
    }

    setAttachedDeposit(deposit: bigint) {
        this._attachedDeposit = deposit;
    }

    setPredecessorAccountId(id: string) {
        this._predecessorAccountId = id;
    }

    setSignerAccountId(id: string) {
        this._signerAccountId = id;
    }

    setCurrentAccountId(id: string) {
        this._currentAccountId = id;
    }

    reset() {
        this.storage = {};
        this.registers = {};
        this._args = "{}";
        this._logs = [];
        this.latestReturnValue = "";
    }

    snapshotStorage(): Record<string, Uint8Array> {
        const snapshot: Record<string, Uint8Array> = {};
        for (const key of Object.keys(this.storage)) {
            snapshot[key] = new Uint8Array(this.storage[key]);
        }
        return snapshot;
    }

    restoreStorage(snapshot: Record<string, Uint8Array>) {
        this.storage = {};
        for (const key of Object.keys(snapshot)) {
            this.storage[key] = new Uint8Array(snapshot[key]);
        }
    }

    // --- NEAR host functions (imported by the WASM contract) ---

    private setRegisterStringValue(key: number | bigint, str: string) {
        this.registers[Number(key)] = new TextEncoder().encode(str);
    }

    /** Returns an object with all the env functions, bound to this instance */
    getImports(): Record<string, Function> {
        /* eslint-disable @typescript-eslint/no-this-alias */
        const self = this;
        return {
            input(registerId: bigint) {
                self.registers[Number(registerId)] = new TextEncoder().encode(
                    self._args,
                );
            },

            storage_usage(): bigint {
                let usage = 0;
                for (const k of Object.keys(self.storage)) {
                    usage += k.length + 1;
                    usage += self.storage[k].length + 1;
                }
                return BigInt(usage);
            },

            storage_write(
                keyLen: bigint,
                keyPtr: bigint,
                valueLen: bigint,
                valuePtr: bigint,
                registerId: bigint,
            ): bigint {
                const buf = new Uint8Array(self.memory.buffer);
                const key = new TextDecoder().decode(
                    buf.slice(Number(keyPtr), Number(keyPtr) + Number(keyLen)),
                );
                const val = new Uint8Array(
                    self.memory.buffer.slice(
                        Number(valuePtr),
                        Number(valuePtr) + Number(valueLen),
                    ),
                );
                let existed = 0n;
                if (self.storage[key] !== undefined) {
                    self.registers[Number(registerId)] = self.storage[key];
                    existed = 1n;
                }
                self.storage[key] = val;
                return existed;
            },

            storage_read(
                keyLen: bigint,
                keyPtr: bigint,
                registerId: bigint,
            ): bigint {
                const buf = new Uint8Array(self.memory.buffer);
                const key = new TextDecoder().decode(
                    buf.slice(Number(keyPtr), Number(keyPtr) + Number(keyLen)),
                );
                if (self.storage[key] !== undefined) {
                    self.registers[Number(registerId)] = self.storage[key];
                    return 1n;
                }
                return 0n;
            },

            storage_remove(
                keyLen: bigint,
                keyPtr: bigint,
                registerId: bigint,
            ): bigint {
                const buf = new Uint8Array(self.memory.buffer);
                const key = new TextDecoder().decode(
                    buf.slice(Number(keyPtr), Number(keyPtr) + Number(keyLen)),
                );
                if (self.storage[key] !== undefined) {
                    self.registers[Number(registerId)] = self.storage[key];
                    delete self.storage[key];
                    return 1n;
                }
                return 0n;
            },

            storage_has_key(keyLen: bigint, keyPtr: bigint): bigint {
                const buf = new Uint8Array(self.memory.buffer);
                const key = new TextDecoder().decode(
                    buf.slice(Number(keyPtr), Number(keyPtr) + Number(keyLen)),
                );
                return self.storage[key] !== undefined ? 1n : 0n;
            },

            read_register(registerId: bigint, ptr: bigint) {
                const regValue = self.registers[Number(registerId)];
                if (regValue !== undefined && regValue.length > 0) {
                    new Uint8Array(self.memory.buffer).set(
                        regValue,
                        Number(ptr),
                    );
                }
            },

            register_len(registerId: bigint): bigint {
                const content = self.registers[Number(registerId)];
                return content !== undefined
                    ? BigInt(content.length)
                    : BigInt("0xffffffffffffffff");
            },

            current_account_id(register: bigint) {
                self.setRegisterStringValue(register, self._currentAccountId);
            },

            signer_account_id(register: bigint) {
                self.setRegisterStringValue(register, self._signerAccountId);
            },

            predecessor_account_id(register: bigint) {
                self.setRegisterStringValue(
                    register,
                    self._predecessorAccountId,
                );
            },

            attached_deposit(balancePtr: bigint) {
                const view = new DataView(self.memory.buffer);
                view.setBigUint64(
                    Number(balancePtr),
                    self._attachedDeposit,
                    true,
                );
                view.setBigUint64(
                    Number(balancePtr) + 8,
                    self._attachedDeposit >> 64n,
                    true,
                );
            },

            account_balance(balancePtr: bigint) {
                const view = new DataView(self.memory.buffer);
                // Return 1000 NEAR so the contract doesn't panic on balance checks
                const balance = 1000n * 10n ** 24n;
                view.setBigUint64(
                    Number(balancePtr),
                    balance & ((1n << 64n) - 1n),
                    true,
                );
                view.setBigUint64(Number(balancePtr) + 8, balance >> 64n, true);
            },

            account_locked_balance(balancePtr: bigint) {
                const view = new DataView(self.memory.buffer);
                view.setBigUint64(Number(balancePtr), 0n, true);
                view.setBigUint64(Number(balancePtr) + 8, 0n, true);
            },

            block_timestamp(): bigint {
                return BigInt(Date.now()) * 1_000_000n;
            },

            block_index(): bigint {
                return 100_000_000n;
            },

            epoch_height(): bigint {
                return 1000n;
            },

            prepaid_gas(): bigint {
                return 300_000_000_000_000n; // 300 TGas
            },

            used_gas(): bigint {
                return 0n;
            },

            value_return(valueLen: bigint, valuePtr: bigint) {
                self.latestReturnValue = new TextDecoder().decode(
                    self.memory.buffer.slice(
                        Number(valuePtr),
                        Number(valuePtr) + Number(valueLen),
                    ),
                );
            },

            log_utf8(len: bigint, ptr: bigint) {
                const msg = new TextDecoder().decode(
                    self.memory.buffer.slice(
                        Number(ptr),
                        Number(ptr) + Number(len),
                    ),
                );
                self._logs.push(msg);
            },

            log_utf16() {},

            panic_utf8(len: bigint, ptr: bigint) {
                const msg = new TextDecoder().decode(
                    self.memory.buffer.slice(
                        Number(ptr),
                        Number(ptr) + Number(len),
                    ),
                );
                throw new Error(`NEAR panic: ${msg}`);
            },

            panic() {
                throw new Error("NEAR panic (no message)");
            },

            abort(msgPtr: bigint, filePtr: bigint, line: bigint, col: bigint) {
                throw new Error(`WASM abort at line ${line}:${col}`);
            },

            // SHA-256 - needed by some NEAR SDK collections
            sha256(valueLen: bigint, valuePtr: bigint, registerId: bigint) {
                // Simple SHA-256 not available synchronously in browsers.
                // sputnik-dao v2 uses LookupMap (no hashing needed for keys).
                // Return a dummy 32-byte hash - only needed if blob storage is used.
                const dummy = new Uint8Array(32);
                self.registers[Number(registerId)] = dummy;
            },

            keccak256(_vl: bigint, _vp: bigint, _r: bigint) {},
            keccak512(_vl: bigint, _vp: bigint, _r: bigint) {},
            ripemd160(_vl: bigint, _vp: bigint, _r: bigint) {},
            ecrecover() {
                return 0n;
            },
            ed25519_verify() {
                return 0n;
            },

            random_seed(registerId: bigint) {
                const seed = new Uint8Array(32);
                self.registers[Number(registerId)] = seed;
            },

            signer_account_pk(registerId: bigint) {
                // ed25519 public key: 1 byte prefix + 32 bytes
                const pk = new Uint8Array(33);
                pk[0] = 0; // ed25519 curve type
                self.registers[Number(registerId)] = pk;
            },

            write_register() {},

            // Promise functions - no-op stubs
            promise_create(): bigint {
                return 0n;
            },
            promise_then(): bigint {
                return 0n;
            },
            promise_and(): bigint {
                return 0n;
            },
            promise_batch_create(): bigint {
                return 0n;
            },
            promise_batch_then(): bigint {
                return 0n;
            },
            promise_results_count(): bigint {
                return 0n;
            },
            promise_result(): bigint {
                return 0n;
            },
            promise_return() {},
            promise_batch_action_create_account() {},
            promise_batch_action_deploy_contract() {},
            promise_batch_action_function_call() {},
            promise_batch_action_function_call_weight() {},
            promise_batch_action_transfer() {},
            promise_batch_action_stake() {},
            promise_batch_action_add_key_with_full_access() {},
            promise_batch_action_add_key_with_function_call() {},
            promise_batch_action_delete_key() {},
            promise_batch_action_delete_account() {},

            validator_stake() {},
            validator_total_stake() {},

            // Storage staking price
            storage_byte_cost(balancePtr: bigint) {
                const view = new DataView(self.memory.buffer);
                const cost = 10_000_000_000_000_000_000n; // 10^19 yoctoNEAR per byte
                view.setBigUint64(
                    Number(balancePtr),
                    cost & ((1n << 64n) - 1n),
                    true,
                );
                view.setBigUint64(Number(balancePtr) + 8, cost >> 64n, true);
            },
        };
    }
}
