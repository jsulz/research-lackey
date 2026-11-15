// Screenshot receipts. Run: npm run screenshot -- <url> <out.png> [--wait <selector>] [--map <host>=<ip>]
// --map points a hostname at an IP, for a domain this machine cannot resolve yet (fresh deploy).
// First run on a machine: npx playwright install chromium
import { chromium } from "playwright";

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args.splice(i, 2)[1] : undefined;
};
const wait = flag("--wait");
const map = flag("--map");
const [url, out] = args;
if (!url || !out) {
  console.error(
    "usage: npm run screenshot -- <url> <out.png> [--wait <selector>] [--map <host>=<ip>]",
  );
  process.exit(2);
}

const browser = await chromium.launch({
  args: map ? [`--host-resolver-rules=MAP ${map.replace("=", " ")}`] : [],
});
try {
  const page = await browser.newPage({ viewport: { width: 1100, height: 600 } });
  await page.goto(url);
  if (wait) await page.waitForSelector(wait, { timeout: 15000 });
  await page.screenshot({ path: out, fullPage: true });
  console.log(`saved ${out}`);
} finally {
  await browser.close();
}
