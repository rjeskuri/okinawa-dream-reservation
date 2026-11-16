// harness-red only runs names on its hardcoded list, which leaves out *.e2e.ts, so this file runs them under one it accepts.
// It holds no assertions, and it can go once harness-red runs *.e2e.ts.
// #50: this runs the review fix's tests of the package the booking form starts on and the pickup times that follow it.
// #137: this runs date-picker.e2e.ts, the calendar behind the date field on the model page, the home search and the listing.
import "./model-page.e2e.ts";
import "./date-picker.e2e.ts";
