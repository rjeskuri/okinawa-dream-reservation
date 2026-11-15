// harness-red only runs names on its hardcoded list, which leaves out *.e2e.ts, so this file runs them under one it accepts.
// It holds no assertions, and it can go once harness-red runs *.e2e.ts. A red check runs only changed files, so a branch
// that changes webhook.e2e.ts changes this file too, or its checks and runs leave webhook.e2e.ts out.
import "./webhook.e2e.ts";
