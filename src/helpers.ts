import * as core from "@actions/core";
import * as github from "@actions/github";
import { formatDuration } from "@allurereport/core-api";
import type { PluginSummary, SummaryTestResult } from "@allurereport/plugin-api";

export type TestResultWithLink = SummaryTestResult & {
  remoteHref?: string;
};

// Build a formatted list of test results
export const buildTestResultsList = (testResults: TestResultWithLink[]): string => {
  const formattedLines: string[] = [];

  testResults.forEach((testItem) => {
    const iconUrl = `https://allurecharts.qameta.workers.dev/dot?type=${testItem.status}&size=8`;
    const statusIndicator = `<img src="${iconUrl}" />`;
    const statusLabel = `${statusIndicator} ${testItem.status}`;
    const testLabel = testItem.remoteHref ? `[${testItem.name}](${testItem.remoteHref})` : testItem.name;
    const testDuration = formatDuration(testItem.duration);

    formattedLines.push(`- ${statusLabel} ${testLabel} (${testDuration})`);
  });

  return formattedLines.join("\n");
};

// Create or update a PR comment with a unique marker
export const upsertPullRequestComment = async (config: {
  octokit: ReturnType<typeof initializeGitHubClient>;
  owner: string;
  repo: string;
  issue_number: number;
  marker: string;
  body: string;
}): Promise<void> => {
  const { octokit, owner, repo, issue_number, marker, body } = config;
  const fullCommentBody = `${marker}\n${body}`;

  const { data: allComments } = await octokit.rest.issues.listComments({
    owner,
    repo,
    issue_number,
  });

  const foundComment = allComments.find((comment) => comment.body?.includes(marker));

  if (foundComment) {
    await octokit.rest.issues.updateComment({
      owner,
      repo,
      comment_id: foundComment.id,
      body: fullCommentBody,
    });
  } else {
    await octokit.rest.issues.createComment({
      owner,
      repo,
      issue_number,
      body: fullCommentBody,
    });
  }
};

// Generate markdown table from Allure report summaries
export const createReportMarkdownSummary = (reportSummaries: PluginSummary[]): string => {
  const tableHeader = `|  | Name | Duration | Stats | New | Flaky | Retry | Report |`;
  const tableDivider = `|-|-|-|-|-|-|-|-|`;

  const tableRows = reportSummaries.map((reportData) => {
    const testStatistics = {
      unknown: reportData?.stats?.unknown ?? 0,
      passed: reportData?.stats?.passed ?? 0,
      failed: reportData?.stats?.failed ?? 0,
      broken: reportData?.stats?.broken ?? 0,
      skipped: reportData?.stats?.skipped ?? 0,
      ...reportData.stats,
    };

    const pieChartUrl = `https://allurecharts.qameta.workers.dev/pie?passed=${testStatistics.passed}&failed=${testStatistics.failed}&broken=${testStatistics.broken}&skipped=${testStatistics.skipped}&unknown=${testStatistics.unknown}&size=32`;
    const pieChart = `<img src="${pieChartUrl}" width="28px" height="28px" />`;
    const reportName = reportData?.name ?? "Allure Report";
    const totalDuration = formatDuration(reportData?.duration ?? 0);

    const generateStatusBadge = (type: string, count: number): string => {
      return `<img alt="${type.charAt(0).toUpperCase() + type.slice(1)} tests" src="https://allurecharts.qameta.workers.dev/dot?type=${type}&size=8" />&nbsp;<span>${count}</span>`;
    };

    const statusBadges: string[] = [
      { type: "passed", count: testStatistics.passed },
      { type: "failed", count: testStatistics.failed },
      { type: "broken", count: testStatistics.broken },
      { type: "skipped", count: testStatistics.skipped },
      { type: "unknown", count: testStatistics.unknown },
    ]
      .filter((status) => status.count > 0)
      .map((status) => generateStatusBadge(status.type, status.count));

    const newTestsCount = reportData?.newTests?.length ?? 0;
    const flakyTestsCount = reportData?.flakyTests?.length ?? 0;
    const retryTestsCount = reportData?.retryTests?.length ?? 0;
    const rowCells: string[] = [pieChart, reportName, totalDuration, statusBadges.join("&nbsp;&nbsp;&nbsp;")];

    const generateTestCountCell = (count: number, filter: string, remoteHref?: string): string => {
      if (!remoteHref) return count.toString();
      return count > 0
        ? `<a href="${remoteHref}?filter=${filter}" target="_blank">${count}</a>`
        : count.toString();
    };

    const testCounts = [
      { count: newTestsCount, filter: "new" },
      { count: flakyTestsCount, filter: "flaky" },
      { count: retryTestsCount, filter: "retry" },
    ];

    testCounts.forEach((test) => {
      rowCells.push(generateTestCountCell(test.count, test.filter, reportData?.remoteHref));
    });

    rowCells.push(
      reportData?.remoteHref
        ? `<a href="${reportData.remoteHref}" target="_blank">View</a>`
        : ""
    );

    return `| ${rowCells.join(" | ")} |`;
  });

  const markdownLines = ["# Allure Report Summary", tableHeader, tableDivider, ...tableRows];

  return markdownLines.join("\n");
};

// GitHub Actions input retrieval
export const retrieveActionInput = (name: string) => core.getInput(name, { required: false });

// GitHub context accessor
export const fetchWorkflowContext = () => github.context;

// GitHub API client initializer
export const initializeGitHubClient = (token: string) => github.getOctokit(token);

// Remove ANSI color codes from strings
export const removeColorCodes = (text: string, replacementChar?: string): string => {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001b\[\d+m/g, replacementChar ?? "");
};