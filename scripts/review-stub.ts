// Prints a Markdown review block for a public Report. Reads the public API; needs no credentials.
// Run: npm run review-stub -- <report_id> [--base-url <url>]
import { reviewStub } from "./review-stub-lib.ts";

const result = await reviewStub(process.argv.slice(2), (url) => fetch(url));
process.stdout.write(result.stdout);
process.stderr.write(result.stderr);
process.exitCode = result.code;
