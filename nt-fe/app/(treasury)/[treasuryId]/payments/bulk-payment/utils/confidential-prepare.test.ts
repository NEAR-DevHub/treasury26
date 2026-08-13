import { describe, expect, it } from "bun:test";
import { AxiosError, type AxiosResponse } from "axios";
import type {
    BulkPaymentPrepareRequest,
    BulkPaymentPrepareResponse,
} from "@/lib/api";
import {
    buildPrepareRequest,
    createPrepareController,
    deriveQuoteFees,
    isOutOfCreditsError,
    maxQuotedRecipientFee,
    needsFeeRepad,
    type PrepareState,
} from "./confidential-prepare";

const legQuote = (args: {
    amountIn?: string;
    amountInFormatted: string;
    amountOut?: string;
    amountOutFormatted: string;
}) => ({
    amountIn: args.amountIn ?? "0",
    amountInFormatted: args.amountInFormatted,
    amountOut: args.amountOut ?? "0",
    amountOutFormatted: args.amountOutFormatted,
});

const prepareResponse = (
    overrides: Partial<BulkPaymentPrepareResponse> = {},
): BulkPaymentPrepareResponse => ({
    bulkAccountId: "dao.bulk-payment.near",
    headerPayloadHash: "header-hash",
    recipientPayloadHashes: ["r1-hash"],
    recipientQuotes: [
        legQuote({ amountInFormatted: "10", amountOutFormatted: "10" }),
    ],
    headerQuote: legQuote({
        amountInFormatted: "10",
        amountOutFormatted: "10",
    }),
    ...overrides,
});

describe("buildPrepareRequest", () => {
    it("pads each amount by the estimated fee and converts to smallest units", () => {
        const request = buildPrepareRequest({
            daoId: "dao.sputnik-dao.near",
            token: { address: "nep141:usdc.near", decimals: 6 },
            payments: [
                { recipient: "alice.near", amount: "10" },
                { recipient: "bob.near", amount: "2.5" },
            ],
            networkFeePerRecipient: "0.25",
            toNearCom: false,
            destinationAsset: "nep141:usdc.eth",
        });

        expect(request.payments).toEqual([
            { recipient: "alice.near", amount: "10250000" },
            { recipient: "bob.near", amount: "2750000" },
        ]);
        expect(request.destinationAsset).toBe("nep141:usdc.eth");
        expect(request.originAsset).toBe("nep141:usdc.near");
        expect(request.decimals).toBe(6);
    });

    it("skips padding and destinationAsset for near.com transfers", () => {
        const request = buildPrepareRequest({
            daoId: "dao.sputnik-dao.near",
            token: { address: "nep141:usdc.near", decimals: 6 },
            payments: [{ recipient: "alice.near", amount: "1" }],
            networkFeePerRecipient: null,
            toNearCom: true,
            destinationAsset: "nep141:usdc.eth",
        });

        expect(request.payments).toEqual([
            { recipient: "alice.near", amount: "1000000" },
        ]);
        expect(request.toNearCom).toBe(true);
        expect(request.destinationAsset).toBeUndefined();
    });

    it("strips nearcom: from recipients before prepare", () => {
        const request = buildPrepareRequest({
            daoId: "dao.sputnik-dao.near",
            token: { address: "nep141:usdc.near", decimals: 6 },
            payments: [{ recipient: "nearcom:alice.near", amount: "1" }],
            networkFeePerRecipient: null,
            toNearCom: true,
        });

        expect(request.payments).toEqual([
            { recipient: "alice.near", amount: "1000000" },
        ]);
    });

    it("lowercases eth-implicit recipients like public quote", () => {
        const checksummed = "0xD7A7486Dba405cBd55FA685Dce53E6E2B755485B";
        const request = buildPrepareRequest({
            daoId: "dao.sputnik-dao.near",
            token: { address: "nep141:usdc.near", decimals: 6 },
            payments: [
                { recipient: `nearcom:${checksummed}`, amount: "1" },
                { recipient: checksummed, amount: "2" },
            ],
            networkFeePerRecipient: null,
            toNearCom: true,
        });

        expect(request.payments.map((p) => p.recipient)).toEqual([
            checksummed.toLowerCase(),
            checksummed.toLowerCase(),
        ]);
    });
});

describe("deriveQuoteFees", () => {
    it("derives per-recipient and total fees from quoted amounts", () => {
        const fees = deriveQuoteFees({
            recipientQuotes: [
                legQuote({
                    amountInFormatted: "10.25",
                    amountOutFormatted: "10.05",
                }),
                legQuote({
                    amountInFormatted: "2.75",
                    amountOutFormatted: "2.55",
                }),
            ],
            headerQuote: legQuote({
                amountInFormatted: "13",
                amountOutFormatted: "13",
            }),
        });

        expect(fees.perRecipientFees.map((f) => f.toString())).toEqual([
            "0.2",
            "0.2",
        ]);
        expect(fees.totalNetworkFee.toString()).toBe("0.4");
    });

    it("includes a non-zero header-leg fee in the total", () => {
        const fees = deriveQuoteFees({
            recipientQuotes: [
                legQuote({ amountInFormatted: "5", amountOutFormatted: "4.9" }),
            ],
            headerQuote: legQuote({
                amountInFormatted: "5",
                amountOutFormatted: "4.99",
            }),
        });

        expect(fees.totalNetworkFee.toString()).toBe("0.11");
    });

    it("reports zero fees for pure intra-Intents transfers", () => {
        const fees = deriveQuoteFees(prepareResponse());
        expect(fees.totalNetworkFee.toString()).toBe("0");
    });
});

describe("maxQuotedRecipientFee / needsFeeRepad", () => {
    it("returns the largest per-recipient fee", () => {
        const fees = deriveQuoteFees({
            recipientQuotes: [
                legQuote({
                    amountInFormatted: "1.30",
                    amountOutFormatted: "0.70",
                }),
                legQuote({
                    amountInFormatted: "2.40",
                    amountOutFormatted: "2.00",
                }),
            ],
            headerQuote: legQuote({
                amountInFormatted: "3.70",
                amountOutFormatted: "3.70",
            }),
        });
        expect(maxQuotedRecipientFee(fees).toString()).toBe("0.6");
    });

    it("needs re-pad when firm fee exceeds the current pad", () => {
        const fees = deriveQuoteFees({
            recipientQuotes: [
                legQuote({
                    amountInFormatted: "1.30",
                    amountOutFormatted: "0.70",
                }),
            ],
            headerQuote: legQuote({
                amountInFormatted: "1.30",
                amountOutFormatted: "1.30",
            }),
        });
        expect(needsFeeRepad("0.3", fees)).toBe(true);
        expect(needsFeeRepad("0.6", fees)).toBe(false);
        expect(needsFeeRepad(null, fees)).toBe(true);
    });
});

describe("isOutOfCreditsError", () => {
    const axiosErrorWithStatus = (status: number) =>
        new AxiosError("Request failed", "ERR_BAD_REQUEST", undefined, null, {
            status,
        } as AxiosResponse);

    it("recognizes a 402 prepare rejection", () => {
        expect(isOutOfCreditsError(axiosErrorWithStatus(402))).toBe(true);
    });

    it("rejects other HTTP failures and non-axios errors", () => {
        expect(isOutOfCreditsError(axiosErrorWithStatus(502))).toBe(false);
        expect(isOutOfCreditsError(new Error("quote failed"))).toBe(false);
        expect(isOutOfCreditsError(undefined)).toBe(false);
    });
});

describe("createPrepareController", () => {
    const someRequest = (amount = "1000000"): BulkPaymentPrepareRequest => ({
        daoId: "dao.sputnik-dao.near",
        originAsset: "nep141:usdc.near",
        toNearCom: true,
        decimals: 6,
        payments: [{ recipient: "alice.near", amount }],
    });

    function deferredFetcher() {
        const calls: Array<{
            request: BulkPaymentPrepareRequest;
            resolve: (r: BulkPaymentPrepareResponse) => void;
            reject: (e: unknown) => void;
        }> = [];
        const fetcher = (request: BulkPaymentPrepareRequest) =>
            new Promise<BulkPaymentPrepareResponse>((resolve, reject) => {
                calls.push({ request, resolve, reject });
            });
        return { calls, fetcher };
    }

    const tick = () => new Promise<void>((r) => setTimeout(r, 0));

    it("is idle until a payload is set, then loads and surfaces the response", async () => {
        const { calls, fetcher } = deferredFetcher();
        const controller = createPrepareController(fetcher);
        expect(controller.getState().status).toBe("idle");

        controller.setRequest(someRequest());
        expect(controller.getState().status).toBe("loading");
        expect(calls).toHaveLength(1);

        const response = prepareResponse();
        calls[0].resolve(response);
        await tick();
        const state = controller.getState();
        expect(state.status).toBe("success");
        expect(
            (state as Extract<PrepareState, { status: "success" }>).data,
        ).toBe(response);
    });

    it("surfaces failures and retries the same payload on demand", async () => {
        const { calls, fetcher } = deferredFetcher();
        const controller = createPrepareController(fetcher);

        controller.setRequest(someRequest());
        calls[0].reject(new Error("quote failed"));
        await tick();
        expect(controller.getState().status).toBe("error");

        controller.retry();
        expect(controller.getState().status).toBe("loading");
        expect(calls).toHaveLength(2);
        expect(calls[1].request).toEqual(calls[0].request);

        calls[1].resolve(prepareResponse());
        await tick();
        expect(controller.getState().status).toBe("success");
    });

    it("does not re-fire for a content-identical payload", async () => {
        const { calls, fetcher } = deferredFetcher();
        const controller = createPrepareController(fetcher);

        controller.setRequest(someRequest());
        calls[0].resolve(prepareResponse());
        await tick();

        controller.setRequest(someRequest());
        expect(calls).toHaveLength(1);
        expect(controller.getState().status).toBe("success");
    });

    it("re-fires when the payload changes and discards the stale in-flight response", async () => {
        const { calls, fetcher } = deferredFetcher();
        const controller = createPrepareController(fetcher);

        controller.setRequest(someRequest("1000000"));
        controller.setRequest(someRequest("2000000"));
        expect(calls).toHaveLength(2);

        // The first (stale) call resolving must not overwrite the fresh one.
        calls[0].resolve(prepareResponse({ headerPayloadHash: "stale" }));
        await tick();
        expect(controller.getState().status).toBe("loading");

        calls[1].resolve(prepareResponse({ headerPayloadHash: "fresh" }));
        await tick();
        const state = controller.getState();
        expect(state.status).toBe("success");
        expect(
            (state as Extract<PrepareState, { status: "success" }>).data
                .headerPayloadHash,
        ).toBe("fresh");
    });

    it("returns to idle when the payload clears and ignores late responses", async () => {
        const { calls, fetcher } = deferredFetcher();
        const controller = createPrepareController(fetcher);

        controller.setRequest(someRequest());
        controller.setRequest(null);
        expect(controller.getState().status).toBe("idle");

        calls[0].resolve(prepareResponse());
        await tick();
        expect(controller.getState().status).toBe("idle");
    });

    it("notifies subscribers on every transition", async () => {
        const { calls, fetcher } = deferredFetcher();
        const controller = createPrepareController(fetcher);
        const seen: string[] = [];
        const unsubscribe = controller.subscribe(() => {
            seen.push(controller.getState().status);
        });

        controller.setRequest(someRequest());
        calls[0].resolve(prepareResponse());
        await tick();
        expect(seen).toEqual(["loading", "success"]);

        unsubscribe();
        controller.setRequest(null);
        expect(seen).toEqual(["loading", "success"]);
    });
});
