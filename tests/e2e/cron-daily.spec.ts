// harness-red only runs names on its hardcoded list, which leaves out *.e2e.ts, so this file runs them under one it accepts.
// It holds no assertions, and it can go once harness-red runs *.e2e.ts. Added for the red check of the daily cron (#44).
import "./cron-daily.e2e.ts";
