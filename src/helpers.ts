import * as core from "@actions/core";
import * as github from "@actions/github";
import { formatDuration } from "@allurereport/core-api";
import type { PluginSummary, QualityGateValidationResult, SummaryTestResult } from "@allurereport/plugin-api";
import * as path from "node:path";
import { existsSync } from "node:fs";

export type TestResultWithLink = SummaryTestResult & {
  remoteHref?: string;
};

export type EnrichedReportSummary = PluginSummary & {
  summaryId: string;
};

export type QualityGateContent =
  | QualityGateValidationResult[]
  | Record<string, QualityGateValidationResult[]>;

export const SUPPORTED_SUMMARY_SECTIONS = ["new", "flaky", "retry"] as const;

export type SummarySectionKey = (typeof SUPPORTED_SUMMARY_SECTIONS)[number];

export const SECTION_COMMENT_MARKER_PREFIX = "<!-- allure-report-section:";

type SectionConfiguration = {
  filter: SummarySectionKey;
  heading: string;
  testCollectionKey: "newTests" | "flakyTests" | "retryTests";
};

const SECTION_CONFIGURATIONS: Record<SummarySectionKey, SectionConfiguration> = {
  new: { filter: "new", heading: "New Tests", testCollectionKey: "newTests" },
  flaky: { filter: "flaky", heading: "Flaky Tests", testCollectionKey: "flakyTests" },
  retry: { filter: "retry", heading: "Retry Tests", testCollectionKey: "retryTests" },
};

const SECTION_KEYWORD_ALIASES: Record<string, SummarySectionKey> = {
  "new": "new",
  "new-tests": "new",
  "flaky": "flaky",
  "flaky-tests": "flaky",
  "retry": "retry",
  "retry-tests": "retry",
};

const DEFAULT_SECTION_COMMENT_BODY_LIMIT = 60_000;

type StoredComment = {
  id: number;
  body?: string | null;
};

const escapeMarkdownTablePipe = (value: string): string => value.split("|").join("\\|");

const escapeHtmlValue = (input: string): string => {
  return input
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
};

export const buildExternalAnchor = (href: string, label: string): string => {
  return `<a href="${escapeHtmlValue(href)}" target="_blank" rel="noopener noreferrer">${escapeHtmlValue(label)}</a>`;
};

export const convertSeparatorsToForwardSlash = (value: string): string => {
  return value.split(path.sep).join("/");
};

// Build a formatted list of test results
export const buildTestResultsList = (testResults: TestResultWithLink[]): string => {
  const formattedLines: string[] = [];

  testResults.forEach((testItem) => {
    formattedLines.push(formatSingleTestEntry(testItem));
  });

  return formattedLines.join("\n");
};

export const formatSingleTestEntry = (testItem: TestResultWithLink): string => {
  const iconUrl = `https://allurecharts.qameta.workers.dev/dot?type=${testItem.status}&size=8`;
  const statusIndicator = `<img src="${iconUrl}" />`;
  const statusLabel = `${statusIndicator} ${testItem.status}`;
  const testLabel = testItem.remoteHref ? buildExternalAnchor(testItem.remoteHref, testItem.name) : testItem.name;
  const testDuration = formatDuration(testItem.duration);

  return `- ${statusLabel} ${testLabel} (${testDuration})`;
};

// Create or update a PR comment with a unique marker.
// When `existingComments` is supplied, it is reused instead of calling listComments again.
export const upsertPullRequestComment = async (config: {
  octokit: ReturnType<typeof initializeGitHubClient>;
  owner: string;
  repo: string;
  issue_number: number;
  marker: string;
  body: string;
  existingComments?: StoredComment[];
}): Promise<void> => {
  const { octokit, owner, repo, issue_number, marker, body, existingComments } = config;
  const fullCommentBody = `${marker}\n${body}`;

  const commentsToInspect =
    existingComments ??
    (
      await octokit.rest.issues.listComments({
        owner,
        repo,
        issue_number,
      })
    ).data;

  const foundComment = commentsToInspect.find((comment) => comment.body?.includes(marker));

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

// Delete comments whose first line starts with `prefix` and whose marker is not in `keepMarkers`.
export const removeStaleMarkerComments = async (config: {
  octokit: ReturnType<typeof initializeGitHubClient>;
  owner: string;
  repo: string;
  existingComments: StoredComment[];
  prefix: string;
  keepMarkers?: Set<string>;
}): Promise<void> => {
  const { octokit, owner, repo, existingComments, prefix, keepMarkers = new Set() } = config;

  const obsoleteComments = existingComments.filter((comment) => {
    const firstLine = comment.body?.split("\n", 1)[0];
    return Boolean(firstLine?.startsWith(prefix) && !keepMarkers.has(firstLine));
  });

  await Promise.all(
    obsoleteComments.map((comment) =>
      octokit.rest.issues.deleteComment({
        owner,
        repo,
        comment_id: comment.id,
      }),
    ),
  );
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
    const reportName = escapeMarkdownTablePipe(reportData?.name ?? "Allure Report");
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
        ? buildExternalAnchor(`${remoteHref}?filter=${filter}`, count.toString())
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
        ? buildExternalAnchor(reportData.remoteHref, "View")
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

// ---------------------------------------------------------------------------
// Quality gate (supports both legacy flat-list and env-keyed object formats)
// ---------------------------------------------------------------------------

export const hasQualityGateFailures = (content?: QualityGateContent): boolean => {
  if (!content) return false;
  if (Array.isArray(content)) return content.length > 0;
  return Object.values(content).flat().length > 0;
};

const formatQualityGateRuleEntries = (results: QualityGateValidationResult[]): string => {
  const lines: string[] = [];
  results.forEach((result) => {
    lines.push(`**${result.rule}** has failed:`);
    lines.push("```shell");
    lines.push(removeColorCodes(result.message));
    lines.push("```");
    lines.push("");
  });
  return lines.join("\n");
};

export const formatQualityGateBody = (content: QualityGateContent): string => {
  if (Array.isArray(content)) {
    return formatQualityGateRuleEntries(content);
  }

  const blocks: string[] = [];
  Object.entries(content).forEach(([envName, results]) => {
    blocks.push([`**Environment**: "${envName}"`, formatQualityGateRuleEntries(results)].join("\n"));
  });
  return blocks.join("\n\n---\n\n");
};

// ---------------------------------------------------------------------------
// Per-summary identifier and remote-href resolution
// ---------------------------------------------------------------------------

export const deriveSummaryIdFromPath = (reportDir: string, summaryFilePath: string): string => {
  const absoluteReportDir = path.resolve(reportDir);
  const absoluteSummaryFile = path.resolve(summaryFilePath);

  if (absoluteSummaryFile.startsWith(`${absoluteReportDir}${path.sep}`)) {
    return convertSeparatorsToForwardSlash(path.relative(absoluteReportDir, absoluteSummaryFile));
  }
  return convertSeparatorsToForwardSlash(path.normalize(summaryFilePath));
};

const deriveSummaryDirSuffix = (reportDir: string, summaryFilePath: string): string => {
  const summaryDir = path.dirname(summaryFilePath);
  const normalizedReport = path.normalize(reportDir);
  const normalizedSummary = path.normalize(summaryDir);
  const absoluteReport = path.resolve(reportDir);
  const absoluteSummary = path.resolve(summaryDir);

  const candidates = [
    { base: normalizedReport, target: normalizedSummary },
    { base: absoluteReport, target: absoluteSummary },
  ];

  for (const { base, target } of candidates) {
    if (target === base) return "";
    if (target.startsWith(`${base}${path.sep}`)) {
      return convertSeparatorsToForwardSlash(path.relative(base, target));
    }
  }

  if (normalizedSummary === ".") return "";
  return convertSeparatorsToForwardSlash(normalizedSummary);
};

export const resolvePerSummaryRemoteHref = (params: {
  reportDir: string;
  summaryFilePath: string;
  inputRemoteHref?: string;
  summaryRemoteHref?: string;
}): string | undefined => {
  const { reportDir, summaryFilePath, inputRemoteHref, summaryRemoteHref } = params;

  if (!inputRemoteHref) return summaryRemoteHref;

  const summaryDir = path.dirname(summaryFilePath);
  const indexHtmlPath = path.posix.join(summaryDir, "index.html");

  if (!existsSync(indexHtmlPath)) return inputRemoteHref;

  const dirSuffix = deriveSummaryDirSuffix(reportDir, summaryFilePath);
  if (!dirSuffix) return inputRemoteHref;

  return `${inputRemoteHref.replace(/\/$/, "")}/${dirSuffix}`;
};

// ---------------------------------------------------------------------------
// Section comments ("new", "flaky", "retry")
// ---------------------------------------------------------------------------

const normalizeSectionKeyword = (raw: string): string => {
  return raw
    .trim()
    .toLowerCase()
    .replace(/^[\s[\]"']+|[\s\]"']+$/g, "");
};

export const parseEnabledSummarySections = (rawValue: string): SummarySectionKey[] => {
  const normalizedTokens = rawValue.split(/[\n,]/).map(normalizeSectionKeyword).filter(Boolean);

  if (normalizedTokens.includes("all")) {
    return [...SUPPORTED_SUMMARY_SECTIONS];
  }

  const requested = new Set(
    normalizedTokens
      .map((token) => SECTION_KEYWORD_ALIASES[token])
      .filter((section): section is SummarySectionKey => Boolean(section)),
  );

  return SUPPORTED_SUMMARY_SECTIONS.filter((section) => requested.has(section));
};

export const buildSectionCommentMarker = (summaryId: string, section: SummarySectionKey): string => {
  return `${SECTION_COMMENT_MARKER_PREFIX}${section}:${summaryId} -->`;
};

const readWithTestResultsLinksFlag = (summary: PluginSummary): boolean => {
  const meta = (summary as PluginSummary & { meta?: { withTestResultsLinks?: boolean } }).meta;
  return Boolean(meta?.withTestResultsLinks);
};

const buildPerTestRemoteHref = (summary: PluginSummary, testId: string): string | undefined => {
  if (!summary.remoteHref || !readWithTestResultsLinksFlag(summary)) return undefined;
  return `${summary.remoteHref}#${testId}`;
};

const collectSectionTestEntries = (
  summary: PluginSummary,
  section: SummarySectionKey,
): TestResultWithLink[] => {
  const definition = SECTION_CONFIGURATIONS[section];
  const tests = summary[definition.testCollectionKey] ?? [];

  return tests.map((test) => ({
    ...test,
    remoteHref: buildPerTestRemoteHref(summary, test.id),
  }));
};

const buildSectionFilterHref = (summary: PluginSummary, section: SummarySectionKey): string | undefined => {
  if (!summary.remoteHref) return undefined;
  return `${summary.remoteHref}?filter=${SECTION_CONFIGURATIONS[section].filter}`;
};

const formatSectionToggleLabel = (section: SummarySectionKey, count: number): string => {
  const noun = count === 1 ? "test" : "tests";
  return `Show ${count} ${section} ${noun}`;
};

const renderSectionBody = (
  titleLine: string,
  toggleLine: string,
  contentLines: string[],
): string => {
  return [titleLine, "", "<details>", `<summary>${toggleLine}</summary>`, "", ...contentLines, "</details>"].join("\n");
};

const buildTruncationTail = (summary: PluginSummary, section: SummarySectionKey): string[] => {
  const moreHref = buildSectionFilterHref(summary, section);
  if (!moreHref) return ["", "_List truncated due to comment size limit._", ""];
  return ["", buildExternalAnchor(moreHref, "More"), ""];
};

const buildSectionCommentBody = (
  summary: PluginSummary,
  section: SummarySectionKey,
  options: { bodyCharLimit?: number } = {},
): string | undefined => {
  const { bodyCharLimit = DEFAULT_SECTION_COMMENT_BODY_LIMIT } = options;
  const testEntries = collectSectionTestEntries(summary, section);
  if (!testEntries.length) return undefined;

  const titleLine = `### ${SECTION_CONFIGURATIONS[section].heading} in ${summary?.name ?? "Allure Report"}`;
  const toggleLine = formatSectionToggleLabel(section, testEntries.length);
  const renderedTestLines = testEntries.map((test) => formatSingleTestEntry(test));
  const fullBody = renderSectionBody(titleLine, toggleLine, [...renderedTestLines, ""]);

  if (fullBody.length <= bodyCharLimit) return fullBody;

  const truncationTail = buildTruncationTail(summary, section);
  const retainedLines: string[] = [];

  renderedTestLines.forEach((line) => {
    const probe = renderSectionBody(titleLine, toggleLine, [...retainedLines, line, ...truncationTail]);
    if (probe.length <= bodyCharLimit) retainedLines.push(line);
  });

  return renderSectionBody(titleLine, toggleLine, [...retainedLines, ...truncationTail]);
};

export const assembleSectionComments = (
  summaries: EnrichedReportSummary[],
  sections: SummarySectionKey[],
  options: { bodyCharLimit?: number } = {},
): Array<{ body: string; marker: string }> => {
  const output: Array<{ body: string; marker: string }> = [];

  sections.forEach((section) => {
    summaries.forEach((summary) => {
      const body = buildSectionCommentBody(summary, section, options);
      if (!body) return;
      output.push({
        marker: buildSectionCommentMarker(summary.summaryId, section),
        body,
      });
    });
  });

  return output;
};
