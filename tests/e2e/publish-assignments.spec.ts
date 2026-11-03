// harness-red only runs names on its hardcoded list, which leaves out *.e2e.ts, so this file runs them under one it accepts.
// It holds no assertions, and it can go once harness-red runs *.e2e.ts. Added for the red check of the route's body limit
// and unset secret on #108.
import "./publish-assignments.e2e.ts";
