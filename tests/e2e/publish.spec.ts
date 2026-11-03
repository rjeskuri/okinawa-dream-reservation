// harness-red only runs names on its hardcoded list, which leaves out *.e2e.ts, so this file runs them under one it accepts.
// It holds no assertions, and it can go once harness-red runs *.e2e.ts.
// #103 moves /api/publish's body reader into a shared helper, and the route has to behave as before: the file stays green
// throughout, and its tests of the 413's words and of a body that is not UTF-8 pin what a shared reader could change.
import "./publish.e2e.ts";
