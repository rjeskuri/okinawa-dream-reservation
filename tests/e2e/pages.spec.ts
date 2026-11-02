// harness-red only runs names on its hardcoded list, which leaves out *.e2e.ts, so this file runs them under one it accepts.
// It holds no assertions, and it can go once harness-red runs *.e2e.ts. A red check runs only changed files, so one based on
// a commit of this branch needs this file changed along with pages.e2e.ts, or it finds nothing it can run.
import "./pages.e2e.ts";
