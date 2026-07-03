import { expect, type Page, type Route, test } from "@playwright/test";
import {
    maybeFulfillMockWalletRequest,
    seedMockWalletAccount,
} from "./helpers/mock-wallet";

/**
 * E2E for the Custom Request Templates feature (authoring + fill + pin).
 *
 * Mirrors requests-page.spec.ts: all client-side API calls are route-mocked, while the server
 * component layout's `getTreasuryConfig` resolves against the real sandbox backend — so we reuse the
 * same proven treasury id that already loads in CI rather than invent one the sandbox may not seed.
 *
 * Scope is the pure client-side flows (validation gating, code-mode errors, the pin PUT, and the
 * fill form's required-field gate). The successful submit (sign → relay → form reset) needs a
 * sandbox account seeded to file `add_proposal`; it is left as a `test.fixme` below until that
 * seeding is verified, so this suite never lands a flaky red.
 */

const TREASURY_ID = "requests-e2e-test.sputnik-dao.near";
const ACCOUNT_ID = "test.near";

const TREASURY_POLICY = {
    roles: [
        {
            name: "council",
            kind: { Group: [ACCOUNT_ID] },
            permissions: [
                "*:AddProposal",
                "*:VoteApprove",
                "*:VoteReject",
                "*:VoteRemove",
                "*:ChangePolicy",
            ],
            vote_policy: {},
        },
    ],
    default_vote_policy: {
        weight_kind: "RoleWeight",
        quorum: "0",
        threshold: [1, 2],
    },
    proposal_bond: "100000000000000000000000",
    proposal_period: "604800000000000",
    bounty_bond: "100000000000000000000000",
    bounty_forgiveness_period: "604800000000000",
};

/** A member who can file requests (Requestor) but cannot author templates (no ChangePolicy). */
const PROPOSER_POLICY = {
    ...TREASURY_POLICY,
    roles: [
        {
            name: "requestors",
            kind: { Group: [ACCOUNT_ID] },
            permissions: ["call:AddProposal", "transfer:AddProposal"],
            vote_policy: {},
        },
    ],
};

/** A member who is neither Requestor nor manager — may view the DAO but not the templates feature. */
const BARE_MEMBER_POLICY = {
    ...TREASURY_POLICY,
    roles: [
        {
            name: "voters",
            kind: { Group: [ACCOUNT_ID] },
            permissions: ["*:VoteApprove"],
            vote_policy: {},
        },
    ],
};

/** Can author templates (ChangePolicy) but cannot file one (no `call:AddProposal`). */
const MANAGER_ONLY_POLICY = {
    ...TREASURY_POLICY,
    roles: [
        {
            name: "managers",
            kind: { Group: [ACCOUNT_ID] },
            permissions: ["*:ChangePolicy"],
            vote_policy: {},
        },
    ],
};

/** A transfer-only Requestor — templates build a FunctionCall, so `transfer:AddProposal` can't file
 * one; this member should get NO templates access at all. */
const TRANSFER_ONLY_POLICY = {
    ...TREASURY_POLICY,
    roles: [
        {
            name: "transfer-requestors",
            kind: { Group: [ACCOUNT_ID] },
            permissions: ["transfer:AddProposal"],
            vote_policy: {},
        },
    ],
};

const EMPTY_PROPOSALS = { page: 0, page_size: 15, total: 0, proposals: [] };

/** Full subscription shape — the treasury layout reads `planConfig.limits`, so a stub crashes it. */
const SUBSCRIPTION = {
    accountId: TREASURY_ID,
    planType: "free",
    planConfig: {
        planType: "free",
        name: "Free",
        description: "Free plan",
        limits: {
            monthlyVolumeLimitCents: null,
            overageRateBps: 0,
            exchangeFeeBps: 0,
            monthlyExportCredits: null,
            trialExportCredits: 100,
            monthlyBatchPaymentCredits: null,
            trialBatchPaymentCredits: 50,
            gasCoveredTransactions: null,
            historyLookupMonths: 3,
        },
        pricing: { monthlyPriceCents: null, yearlyPriceCents: null },
    },
    exportCredits: 100,
    batchPaymentCredits: 50,
    gasCoveredTransactions: 100,
    creditsResetAt: "2026-05-06T00:00:00Z",
    monthlyUsedVolumeCents: 0,
};

/** A representative manifest with one required text field — drives the fill + authoring tests. */
const SET_GREETING_MANIFEST = {
    version: 1,
    id: "set-greeting",
    title: "Set Greeting",
    description: "Update the greeting shown on a guest-book contract.",
    binding: {
        receiver_id: "guestbook.near",
        method_name: "set_greeting",
        deposit: "0",
        gas: "30000000000000",
    },
    fields: [
        {
            name: "greeting",
            label: "Greeting",
            type: "text",
            required: true,
            help: "The new message",
        },
    ],
    args: { greeting: "{{greeting}}" },
    summary: "Set greeting to {{greeting}}",
};

/** The JSON text an author pastes into Code mode (same shape as the manifest above). */
const VALID_MANIFEST_TEXT = JSON.stringify(SET_GREETING_MANIFEST, null, 2);

function template(
    overrides: Partial<Record<string, unknown>> = {},
): Record<string, unknown> {
    return {
        id: "11111111-1111-1111-1111-111111111111",
        daoId: TREASURY_ID,
        name: "Set Greeting",
        description: "Update the greeting shown on a guest-book contract.",
        manifest: SET_GREETING_MANIFEST,
        enabled: true,
        pinned: false,
        createdBy: ACCOUNT_ID,
        createdAt: "2026-06-01T00:00:00Z",
        updatedAt: "2026-06-01T00:00:00Z",
        ...overrides,
    };
}

test.use({ locale: "en-US" });

function json(route: Route, body: unknown, status = 200) {
    return route.fulfill({
        status,
        contentType: "application/json",
        body: JSON.stringify(body),
    });
}

/**
 * Mock every client-side call for a signed-in council member who owns the treasury. `GET
 * proposal-templates` returns `templates`; non-GET mutations on that endpoint fall through so a
 * per-test route (registered later, higher priority) can intercept and assert them.
 */
async function setupMocks(
    page: Page,
    templates: Record<string, unknown>[],
    options: { policy?: unknown; customRequestsEnabled?: boolean } = {},
) {
    const policy = options.policy ?? TREASURY_POLICY;
    const customRequestsEnabled = options.customRequestsEnabled ?? true;
    await seedMockWalletAccount(page, ACCOUNT_ID, "init");

    await page.route("**/*", async (route) => {
        if (await maybeFulfillMockWalletRequest(route)) {
            return;
        }
        const request = route.request();
        const url = request.url();
        const method = request.method();

        if (url.includes("/auth/me")) {
            return json(route, { accountId: ACCOUNT_ID, termsAccepted: true });
        }
        if (url.includes("/treasury/creation-status")) {
            return json(route, { creationAvailable: true });
        }
        if (url.includes("/user/treasuries")) {
            return json(route, [
                {
                    daoId: TREASURY_ID,
                    config: { name: "Custom Templates E2E", metadata: {} },
                    isMember: true,
                    isSaved: true,
                    isHidden: false,
                },
            ]);
        }
        if (url.includes("/treasury/policy")) {
            return json(route, policy);
        }
        if (url.includes("/api/subscription/")) {
            return json(route, SUBSCRIPTION);
        }
        if (url.includes("/user/assets")) {
            return json(route, []);
        }
        if (url.includes("/proposals/")) {
            return json(route, EMPTY_PROPOSALS);
        }
        // The Custom Requests feature gate (sidebar visibility + route guard).
        if (url.endsWith("/custom-requests") && method === "GET") {
            return json(route, { enabled: customRequestsEnabled });
        }
        // Template list. Mutations (POST/PUT/DELETE) are owned by per-test routes.
        if (url.includes("/proposal-templates") && method === "GET") {
            return json(route, templates);
        }

        return route.continue();
    });
}

test.describe("Custom Templates — authoring", () => {
    test("submit gating: disabled until a name and a valid manifest are present", async ({
        page,
    }) => {
        await setupMocks(page, []);
        await page.goto(`/${TREASURY_ID}/custom-templates/create`);

        await expect(
            page.getByRole("heading", { name: "New Template" }),
        ).toBeVisible({ timeout: 15000 });

        const submit = page.getByRole("button", { name: "Create Template" });
        // Empty draft is an invalid manifest → disabled out of the gate.
        await expect(submit).toBeDisabled();

        // Author in Code mode (one textarea drives the same validator as Visual).
        await page.getByRole("tab", { name: "Code" }).click();
        const code = page.locator("textarea");
        await code.fill(VALID_MANIFEST_TEXT);

        // Valid manifest, but the name is still empty → still gated.
        await expect(submit).toBeDisabled();

        // Name is addressed by its aria-label — its placeholder "Set Greeting" collides with the
        // manifest textarea's example and the Visual builder's Title field.
        await page
            .getByRole("textbox", { name: "Name", exact: true })
            .fill("My Template");
        await expect(submit).toBeEnabled();
    });

    test("touched-gating: 'Name is required' shows only after the name is blurred", async ({
        page,
    }) => {
        await setupMocks(page, []);
        await page.goto(`/${TREASURY_ID}/custom-templates/create`);

        // Name is addressed by its aria-label (see submit-gating for the placeholder collision).
        const name = page.getByRole("textbox", { name: "Name", exact: true });
        await expect(name).toBeVisible({ timeout: 15000 });

        // Untouched → no error yet (editing the builder must not light it up).
        await expect(page.getByText("Name is required")).not.toBeVisible();

        // Focus then blur without typing → the field is touched and the error appears.
        await name.focus();
        await name.blur();
        await expect(page.getByText("Name is required")).toBeVisible();
    });

    test("code-mode section errors: invalid JSON surfaces errors and blocks submit", async ({
        page,
    }) => {
        await setupMocks(page, []);
        await page.goto(`/${TREASURY_ID}/custom-templates/create`);

        await page.getByRole("tab", { name: "Code" }).click();
        const code = page.locator("textarea");
        // Malformed JSON — only shows once the textarea is touched (typing sets that).
        await code.fill('{ "version": 1, ');

        const submit = page.getByRole("button", { name: "Create Template" });
        await expect(submit).toBeDisabled();
        // The error list under the editor renders at least one item.
        await expect(
            page.locator("ul.text-destructive li").first(),
        ).toBeVisible();
    });

    test("create happy path: POST fires and redirects to the template's fill page", async ({
        page,
    }) => {
        await setupMocks(page, [template()]);

        let created: Record<string, unknown> | null = null;
        await page.route("**/proposal-templates", async (route) => {
            if (route.request().method() !== "POST") {
                return route.fallback();
            }
            created = route.request().postDataJSON();
            return json(route, template(), 201);
        });

        await page.goto(`/${TREASURY_ID}/custom-templates/create`);
        await page.getByRole("tab", { name: "Code" }).click();
        await page.locator("textarea").fill(VALID_MANIFEST_TEXT);
        await page
            .getByRole("textbox", { name: "Name", exact: true })
            .fill("Set Greeting");

        await page.getByRole("button", { name: "Create Template" }).click();

        await page.waitForURL(/custom-templates\/set-greeting$/, {
            timeout: 15000,
        });
        expect(created).toMatchObject({ name: "Set Greeting" });
    });

    test("visual mode: a required field reds only after it is blurred", async ({
        page,
    }) => {
        await setupMocks(page, []);
        await page.goto(`/${TREASURY_ID}/custom-templates/create`);

        // The editor opens in the Visual builder. The Receiver field is required, so the empty draft
        // is already invalid — but the error must stay hidden until that input is touched. The unit
        // tests pin the initial-render half; this is the after-blur half they defer to e2e.
        const receiver = page.getByPlaceholder("guestbook.near");
        await expect(receiver).toBeVisible({ timeout: 15000 });
        await expect(receiver).not.toHaveAttribute("aria-invalid", "true");

        await receiver.focus();
        await receiver.blur();
        await expect(receiver).toHaveAttribute("aria-invalid", "true");
    });
});

test.describe("Custom Templates — pin", () => {
    test("'Pin to the Sidebar' fires a PUT and the menu flips to 'Unpin Template'", async ({
        page,
    }) => {
        // Mutable so the post-mutation refetch (the hook invalidates the list query) reflects the
        // new pinned state — that invalidation→refetch→UI contract is what this asserts.
        const templates = [template({ pinned: false })];
        await setupMocks(page, templates);

        let putBody: Record<string, unknown> | null = null;
        await page.route("**/proposal-templates/*", async (route) => {
            if (route.request().method() !== "PUT") {
                return route.fallback();
            }
            putBody = route.request().postDataJSON();
            templates[0] = { ...templates[0], ...putBody };
            return json(route, templates[0]);
        });

        await page.goto(`/${TREASURY_ID}/custom-templates`);
        await expect(page.getByText("Set Greeting")).toBeVisible({
            timeout: 15000,
        });

        await page.getByRole("button", { name: "Template actions" }).click();
        await page
            .getByRole("menuitem", { name: /pin to the sidebar/i })
            .click();

        // The request carried the flag...
        await expect.poll(() => putBody).toMatchObject({ pinned: true });
        // ...and after the list refetches, re-opening the row menu shows the flipped label.
        await page.getByRole("button", { name: "Template actions" }).click();
        await expect(
            page.getByRole("menuitem", { name: /unpin template/i }),
        ).toBeVisible();
    });
});

test.describe("Custom Templates — fill", () => {
    test("renders the manifest fields and the File Proposal button", async ({
        page,
    }) => {
        await setupMocks(page, [template()]);
        await page.goto(`/${TREASURY_ID}/custom-templates/set-greeting`);

        await expect(
            page.getByRole("heading", { name: "Set Greeting" }),
        ).toBeVisible({ timeout: 15000 });
        // Exact — "Greeting" (the field label) is a substring of the "Set Greeting" heading.
        await expect(page.getByText("Greeting", { exact: true })).toBeVisible();
        await expect(
            page.getByRole("button", { name: "File Proposal" }),
        ).toBeVisible();
    });

    test("required-field gate: submitting empty shows an error and fires no relay", async ({
        page,
    }) => {
        await setupMocks(page, [template()]);

        // Spy on the gasless relay — it must never be hit when validation fails.
        let relayHit = false;
        await page.route("**/relay/delegate-action", async (route) => {
            relayHit = true;
            return json(route, { success: true });
        });

        await page.goto(`/${TREASURY_ID}/custom-templates/set-greeting`);
        const submit = page.getByRole("button", { name: "File Proposal" });
        await expect(submit).toBeVisible({ timeout: 15000 });

        await submit.click();

        await expect(page.getByText("Greeting is required")).toBeVisible();
        expect(relayHit).toBe(false);
    });

    /**
     * Successful fill → sign → relay → form reset. Needs the sandbox seeded with the signing account
     * (test.near) holding the mock executor's access key and council membership so `add_proposal`
     * relays. Enable once that seeding is confirmed against the sandbox image.
     */
    test.fixme(
        "successful submit files the proposal and resets the form",
        async () => {},
    );
});

/**
 * The route/permission gates (#1026, #1027). The rest of the suite runs as a full council member; here
 * we swap the flag and the policy to assert the deny paths — the sidebar-only check used to leave these
 * routes reachable by direct URL.
 */
test.describe("Custom Templates — access gates", () => {
    test("feature disabled: /custom-templates redirects to Settings → Developer (#1026)", async ({
        page,
    }) => {
        await setupMocks(page, [template()], {
            customRequestsEnabled: false,
        });
        await page.goto(`/${TREASURY_ID}/custom-templates`);
        await page.waitForURL(/settings\?tab=developer/, { timeout: 15000 });
    });

    test("bare member (neither propose nor manage) is redirected to the dashboard (#1027)", async ({
        page,
    }) => {
        // No access + can't manage → the treasury dashboard, not a Settings tab hidden from them.
        await setupMocks(page, [template()], { policy: BARE_MEMBER_POLICY });
        await page.goto(`/${TREASURY_ID}/custom-templates`);
        await page.waitForURL(/\/dashboard$/, { timeout: 15000 });
    });

    test("Requestor may reach the list but not the create page — bounced to the list (#1027)", async ({
        page,
    }) => {
        await setupMocks(page, [template()], { policy: PROPOSER_POLICY });
        await page.goto(`/${TREASURY_ID}/custom-templates/create`);
        await page.waitForURL(/custom-templates$/, { timeout: 15000 });
        await expect(page.getByText("Set Greeting")).toBeVisible();
    });

    test("Requestor gets an enabled Create Request; Add New is disabled, ⋮ menu hidden", async ({
        page,
    }) => {
        await setupMocks(page, [template()], { policy: PROPOSER_POLICY });
        await page.goto(`/${TREASURY_ID}/custom-templates`);

        await expect(page.getByText("Set Greeting")).toBeVisible({
            timeout: 15000,
        });
        // Can file a request...
        await expect(
            page.getByRole("button", { name: "Create Request" }),
        ).toBeEnabled();
        // ...authoring "Add New" is shown disabled (with a tooltip), not hidden...
        await expect(
            page.getByRole("button", { name: "Add New" }),
        ).toBeDisabled();
        // ...and the per-row ⋮ overflow (edit/pin/delete) stays hidden.
        await expect(
            page.getByRole("button", { name: "Template actions" }),
        ).toHaveCount(0);
    });

    test("manager without call:AddProposal: authoring enabled, Create Request disabled", async ({
        page,
    }) => {
        await setupMocks(page, [template()], { policy: MANAGER_ONLY_POLICY });
        await page.goto(`/${TREASURY_ID}/custom-templates`);

        await expect(page.getByText("Set Greeting")).toBeVisible({
            timeout: 15000,
        });
        // Can manage (⋮ menu + Add New enabled)...
        await expect(
            page.getByRole("button", { name: "Template actions" }),
        ).toBeVisible();
        await expect(
            page.getByRole("button", { name: "Add New" }),
        ).toBeEnabled();
        // ...but can't file a FunctionCall template → Create Request shown disabled, not hidden.
        await expect(
            page.getByRole("button", { name: "Create Request" }),
        ).toBeDisabled();
    });

    test("transfer-only requestor has no templates access → dashboard", async ({
        page,
    }) => {
        // transfer:AddProposal can't file a FunctionCall template, so it grants no access.
        await setupMocks(page, [template()], { policy: TRANSFER_ONLY_POLICY });
        await page.goto(`/${TREASURY_ID}/custom-templates`);
        await page.waitForURL(/\/dashboard$/, { timeout: 15000 });
    });
});
