import type { SummaryTestResult } from "@allurereport/plugin-api";

export type TestResultWithLink = SummaryTestResult & {
  remoteHref?: string;
};
