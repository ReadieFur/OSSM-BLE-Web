import { getPage } from "./bootstrap";
import { test, expect } from "vitest";

test("should have launched browser and loaded bluetooth", async () => {
    expect(await getPage().evaluate(() => !!navigator.bluetooth)).toBe(true);
});

// TODO: Add automated tests!
