// harness-red only runs names on its hardcoded list, which leaves out *.e2e.ts, so this file runs them under one it accepts.
// It holds no assertions, and it can go once harness-red runs *.e2e.ts. A red check runs only changed files, so one based on
// a commit of this branch needs this file changed along with rentals.e2e.ts, or it finds nothing it can run.
// #94's tests in rentals.e2e.ts run through this file, the package-select default tests of its fix round included.
// #97's tests of a search with a type and no package run through this file.
import "./rentals.e2e.ts";
