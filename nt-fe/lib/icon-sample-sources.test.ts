import { describe, expect, it } from "bun:test";
import { iconSampleSources } from "./icon-sample-sources";

describe("iconSampleSources", () => {
    it("proxies a remote icon through the optimizer before trying it directly", () => {
        expect(
            iconSampleSources(
                "https://s2.coinmarketcap.com/static/img/coins/128x128/1.png",
            ),
        ).toEqual([
            "/_next/image?url=https%3A%2F%2Fs2.coinmarketcap.com%2Fstatic%2Fimg%2Fcoins%2F128x128%2F1.png&w=32&q=75",
            "https://s2.coinmarketcap.com/static/img/coins/128x128/1.png?accent=1",
        ]);
    });

    it("appends to an existing query string on the direct fallback", () => {
        expect(iconSampleSources("https://cdn.example/icon.png?v=2")[1]).toBe(
            "https://cdn.example/icon.png?v=2&accent=1",
        );
    });

    it("uses a data URI as-is", () => {
        const uri =
            "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg'/>";
        expect(iconSampleSources(uri)).toEqual([uri]);
    });

    it("uses a site-relative icon as-is", () => {
        expect(iconSampleSources("/icons/near.svg")).toEqual([
            "/icons/near.svg",
        ]);
    });
});
