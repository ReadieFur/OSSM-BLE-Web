// bootstrap.ts
import http from "http";
import puppeteer, { Browser, Page } from "puppeteer";
import path from "path";
import { readFile } from "fs/promises";
import { afterAll, beforeAll, beforeEach } from "vitest";

export interface ServerEnvironment {
    httpServer: http.Server;
    browser: Browser;
    page: Page;
}

let env: ServerEnvironment;

// Chrome test browser environment setup
async function startEnvironment(port = 3000): Promise<ServerEnvironment> {
  const httpServer = http.createServer(async (req, res) => {
        if (req.url === "/" || req.url === "/index.html") {
            res.writeHead(200, { "Content-Type": "text/html" });
            return res.end(`<!doctypehtml><html lang=en><meta charset=UTF-8><title>Web Bluetooth Test</title><style>body{background-color:#000;color:#fff;}</style><script src=/dist/ossm-ble-web.global.js></script><div id=app>Web Bluetooth Test Harness</div>`);
        }

        // Serve project files (e.g. /dist/index.js)
        const filePath = path.join(process.cwd(), req.url!);
        try {
        const fileContent = await readFile(filePath);
            const isJs = req.url?.endsWith(".js");
            res.writeHead(200, {
                "Content-Type": isJs ? "application/javascript" : "text/plain",
            });
            res.end(fileContent);
        } catch {
            res.writeHead(404);
            res.end("File not found");
        }
    });

    await new Promise<void>((resolve) => httpServer.listen(port, resolve));

    const browser = await puppeteer.launch({
        headless: false,
        devtools: true,
        debuggingPort: 9222,
        args: [
            "--window-size=900,700",
            "--enable-features=WebBluetooth",
            "--enable-experimental-web-platform-features",
            `--unsafely-treat-insecure-origin-as-secure=http://localhost:${port}`,
        ],
    });

    const page = await browser.newPage();

    // Pipe browser logs directly to host terminal
    page.on("console", (msg) => console.log(`[Browser Console] ${msg.text()}`));
    page.on("pageerror", (err) => console.error("[Browser Error]", err));

    await page.goto(`http://localhost:${port}/`);
    await page.bringToFront();

    // Close default blank tab if open
    const pages = await browser.pages();
    for (const p of pages) {
        if (p !== page) await p.close();
    }

    return { httpServer, browser, page };
}

// Global lifecycle hooks
beforeAll(async () => {
    env = await startEnvironment();
});

beforeEach(async () => {
    if (env?.page) {
        // Reset page runtime state between tests
        await env.page.reload({ waitUntil: ["networkidle0", "domcontentloaded"] });
    }
});

afterAll(async () => {
    if (env) {
        // Clean up the test environment
        await env.browser?.close();
        await env.httpServer?.close();
    }
});

// Getter functions to safely access the environment inside test blocks
export const getPage = () => env.page;
export const getBrowser = () => env.browser;
export const getServer = () => env.httpServer;
