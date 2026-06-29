/**
 * Pins the "no red until touched" contract for the authoring form. Uses react-dom/server (no DOM
 * harness, no testing-library) to assert the *initial* render — i.e. the load state, before any
 * blur/edit — which is exactly the regression these tests guard against ("red whole form on load").
 * The interactive half (error appears *after* blur) belongs in the Playwright e2e.
 */
import { describe, expect, it } from "bun:test";
import { NextIntlClientProvider } from "next-intl";
import { renderToStaticMarkup } from "react-dom/server";
import messages from "@/messages/en.json";
import { emptyDraft } from "../draft";
import { LabeledInput } from "./fields-builder";
import { VisualBuilder } from "./visual-builder";

// The authoring components localize via next-intl, so static rendering needs an intl context (mirrors
// the real (treasury) layout's provider). Real en messages keep the rendered labels honest.
function renderWithIntl(node: React.ReactNode): string {
    return renderToStaticMarkup(
        <NextIntlClientProvider locale="en" messages={messages}>
            {node}
        </NextIntlClientProvider>,
    );
}

describe("LabeledInput touched gating", () => {
    it("does not render its error before the input is touched", () => {
        const html = renderWithIntl(
            <LabeledInput
                label="Receiver"
                value=""
                onChange={() => {}}
                error="receiver is required"
            />,
        );
        expect(html).not.toContain("receiver is required");
    });
});

describe("VisualBuilder section-error gating", () => {
    // An `args:`-prefixed error is routed to the Arguments section foot (a cross-input error).
    const sectionError =
        'args: duplicate argument key "x" — only the last is kept';

    function render(showSectionErrors: boolean): string {
        return renderWithIntl(
            <VisualBuilder
                draft={emptyDraft()}
                errors={[sectionError]}
                showSectionErrors={showSectionErrors}
                onChange={() => {}}
            />,
        );
    }

    it("hides section-foot errors until the builder has been touched", () => {
        expect(render(false)).not.toContain("duplicate argument key");
    });

    it("shows section-foot errors once the builder has been touched", () => {
        expect(render(true)).toContain("duplicate argument key");
    });
});
