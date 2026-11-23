// harness-red only runs names on its hardcoded list, which leaves out *.e2e.ts, so this file runs them under one it accepts.
// It holds no assertions, and it can go once harness-red runs *.e2e.ts. A red check runs only changed files, so a branch
// that changes cancel.e2e.ts changes this file too, or its checks and runs leave cancel.e2e.ts out.
// #151 added the paid-at-shop and block cases to cancel.e2e.ts.
import "./cancel.e2e.ts";
