import * as core from "@actions/core";
import fg from "fast-glob";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import { type Mock, beforeEach, describe, expect, it, vi } from "vitest";
import { executeAction } from "../../src/main.js";
import {
  assembleSectionComments,
  buildSectionCommentMarker,
  fetchWorkflowContext,
  formatQualityGateBody,
  hasQualityGateFailures,
  initializeGitHubClient,
  parseEnabledSummarySections,
  removeColorCodes,
  resolvePerSummaryRemoteHref,
  retrieveActionInput,
} from "../../src/helpers.js";
import { octokitMock } from "../mocks.js";

vi.mock("fast-glob", () => ({
  default: vi.fn(),
}));
vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(),
}));
vi.mock("node:fs", () => ({
  existsSync: vi.fn(),
}));
vi.mock("@actions/core", async (importOriginal) => ({
  ...(await importOriginal()),
  info: vi.fn(),
}));
vi.mock("../../src/helpers.js", async (importOriginal) => {
  const testUtils = await import("../mocks.js");

  return {
    ...(await importOriginal()),
    initializeGitHubClient: vi.fn().mockReturnValue(testUtils.octokitMock),
    fetchWorkflowContext: vi.fn().mockReturnValue({
      repo: {
        owner: "owner",
        repo: "repo",
      },
    }),
    retrieveActionInput: vi.fn(),
  };
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe("Allure Report Action Tests", () => {
  describe("Action execution guard conditions", () => {
    it("exits early when GitHub token is missing", async () => {
      (retrieveActionInput as unknown as Mock).mockReturnValue(undefined);
      (fetchWorkflowContext as unknown as Mock).mockReturnValue({});

      await executeAction();

      expect(fg).not.toHaveBeenCalled();
    });

    it("exits early when event is not a pull request", async () => {
      (retrieveActionInput as unknown as Mock).mockReturnValue("foo");
      (fetchWorkflowContext as unknown as Mock).mockReturnValue({
        eventName: "push",
      });

      await executeAction();

      expect(fg).not.toHaveBeenCalled();
    });

    it("exits early when pull request payload is missing", async () => {
      (retrieveActionInput as unknown as Mock).mockReturnValue("foo");
      (fetchWorkflowContext as unknown as Mock).mockReturnValue({
        eventName: "pull_request",
        payload: {},
      });

      await executeAction();

      expect(fg).not.toHaveBeenCalled();
    });
  });

  describe("Report summary generation", () => {
    beforeEach(() => {
      (retrieveActionInput as unknown as Mock).mockImplementation((input: string) => {
        if (input === "report-directory") {
          return "test/fixtures/action";
        }
        if (input === "github-token") {
          return "token";
        }
        return "";
      });
      (fetchWorkflowContext as unknown as Mock).mockReturnValue({
        eventName: "pull_request",
        repo: {
          owner: "owner",
          repo: "repo",
        },
        payload: {
          pull_request: {
            number: 1,
          },
        },
      });
    });

    it("logs info message when no report summaries found", async () => {
      (fg as unknown as Mock).mockResolvedValue([]);
      (octokitMock.rest.issues.listComments as unknown as Mock).mockResolvedValue({ data: [] });

      await executeAction();

      expect(fs.readFile).not.toHaveBeenCalled();
      expect(initializeGitHubClient).toHaveBeenCalledWith("token");
      expect(core.info).toHaveBeenCalledWith("No published reports found");
      expect(octokitMock.rest.issues.createComment).not.toHaveBeenCalled();
    });

    it("creates PR comment with report summary", async () => {
      const mockSummary = {
        name: "Test Suite",
        stats: {
          passed: 10,
          failed: 2,
          broken: 1,
        },
        duration: 5000,
        newTests: [],
        flakyTests: [],
        retryTests: [],
      };

      (fg as unknown as Mock).mockResolvedValue(["report1/summary.json"]);
      (fs.readFile as unknown as Mock).mockResolvedValueOnce(JSON.stringify(mockSummary));
      (octokitMock.rest.issues.listComments as unknown as Mock).mockResolvedValue({ data: [] });

      await executeAction();

      expect(fs.readFile).toHaveBeenCalledTimes(1);
      expect(initializeGitHubClient).toHaveBeenCalledWith("token");
      expect(octokitMock.rest.issues.createComment).toHaveBeenCalledTimes(1);
      expect(octokitMock.rest.issues.createComment.mock.calls[0][0].body).toContain("<!-- allure-report-summary -->");
      expect(octokitMock.rest.issues.createComment.mock.calls[0][0].body).toContain("Allure Report Summary");
    });

    it("updates existing comment instead of creating new one", async () => {
      const existingCommentId = 123456;
      const mockSummary = {
        name: "Test Suite",
        stats: { passed: 10, failed: 2, broken: 1 },
        duration: 5000,
        newTests: [],
        flakyTests: [],
        retryTests: [],
      };

      (fg as unknown as Mock).mockResolvedValue(["report1/summary.json"]);
      (fs.readFile as unknown as Mock).mockResolvedValueOnce(JSON.stringify(mockSummary));
      (octokitMock.rest.issues.listComments as unknown as Mock).mockResolvedValue({
        data: [
          {
            id: existingCommentId,
            body: "<!-- allure-report-summary -->\n# Old Summary",
          },
        ],
      });

      await executeAction();

      expect(octokitMock.rest.issues.createComment).not.toHaveBeenCalled();
      expect(octokitMock.rest.issues.updateComment).toHaveBeenCalledTimes(1);
      expect(octokitMock.rest.issues.updateComment).toHaveBeenCalledWith({
        owner: "owner",
        repo: "repo",
        comment_id: existingCommentId,
        body: expect.stringContaining("<!-- allure-report-summary -->"),
      });
    });
  });

  describe("Quality gate validation", () => {
    beforeEach(() => {
      (retrieveActionInput as unknown as Mock).mockImplementation((input: string) => {
        if (input === "report-directory") return "test/fixtures/quality-gate";
        if (input === "github-token") return "token";
        return "";
      });
      (fetchWorkflowContext as unknown as Mock).mockReturnValue({
        eventName: "pull_request",
        repo: { owner: "owner", repo: "repo" },
        payload: {
          pull_request: {
            number: 1,
            head: { sha: "abc123" },
          },
        },
      });
    });

    it("creates successful check when quality gate passes", async () => {
      const mockSummary = {
        name: "Test Suite",
        stats: { passed: 10, failed: 0, broken: 0 },
        duration: 5000,
        newTests: [],
        flakyTests: [],
        retryTests: [],
      };

      (fg as unknown as Mock).mockResolvedValue(["test/fixtures/quality-gate/summary.json"]);
      (fs.readFile as unknown as Mock)
        .mockResolvedValueOnce(JSON.stringify(mockSummary))
        .mockResolvedValueOnce(JSON.stringify([]));
      (existsSync as unknown as Mock).mockReturnValue(true);
      (octokitMock.rest.issues.listComments as unknown as Mock).mockResolvedValue({ data: [] });

      await executeAction();

      expect(octokitMock.rest.checks.create).toHaveBeenCalledWith({
        owner: "owner",
        repo: "repo",
        name: "Allure Quality Gate",
        head_sha: "abc123",
        status: "completed",
        conclusion: "success",
        output: undefined,
      });
    });

    it("creates failed check when quality gate fails", async () => {
      const mockSummary = {
        name: "Test Suite",
        stats: { passed: 8, failed: 2, broken: 0 },
        duration: 5000,
        newTests: [],
        flakyTests: [],
        retryTests: [],
      };
      const qualityGateFailures = [
        {
          rule: "Failed tests threshold",
          message: "\u001b[31mFailed tests: 2 exceeds threshold of 0\u001b[0m",
        },
      ];

      (fg as unknown as Mock).mockResolvedValue(["test/fixtures/quality-gate/summary.json"]);
      (fs.readFile as unknown as Mock)
        .mockResolvedValueOnce(JSON.stringify(mockSummary))
        .mockResolvedValueOnce(JSON.stringify(qualityGateFailures));
      (existsSync as unknown as Mock).mockReturnValue(true);
      (octokitMock.rest.issues.listComments as unknown as Mock).mockResolvedValue({ data: [] });

      await executeAction();

      expect(octokitMock.rest.checks.create).toHaveBeenCalledWith({
        owner: "owner",
        repo: "repo",
        name: "Allure Quality Gate",
        head_sha: "abc123",
        status: "completed",
        conclusion: "failure",
        output: {
          title: "Quality Gate",
          summary: expect.stringContaining("Failed tests threshold"),
        },
      });
    });

    it("strips ANSI color codes from quality gate messages", async () => {
      const mockSummary = {
        name: "Test Suite",
        stats: { passed: 8, failed: 2, broken: 0 },
        duration: 5000,
        newTests: [],
        flakyTests: [],
        retryTests: [],
      };
      const qualityGateFailures = [
        {
          rule: "Failed tests threshold",
          message: "\u001b[31mFailed tests: 2 exceeds threshold of 0\u001b[0m",
        },
      ];

      (fg as unknown as Mock).mockResolvedValue(["test/fixtures/quality-gate/summary.json"]);
      (fs.readFile as unknown as Mock)
        .mockResolvedValueOnce(JSON.stringify(mockSummary))
        .mockResolvedValueOnce(JSON.stringify(qualityGateFailures));
      (existsSync as unknown as Mock).mockReturnValue(true);
      (octokitMock.rest.issues.listComments as unknown as Mock).mockResolvedValue({ data: [] });

      await executeAction();

      const summaryOutput = octokitMock.rest.checks.create.mock.calls[0][0].output?.summary;
      expect(summaryOutput).not.toContain("\u001b[31m");
      expect(summaryOutput).not.toContain("\u001b[0m");
      expect(summaryOutput).toContain("Failed tests: 2 exceeds threshold of 0");
    });
  });

  describe("Utility functions", () => {
    it("removes ANSI color codes from text", () => {
      const textWithColors = "\u001b[31mRed text\u001b[0m and \u001b[32mGreen text\u001b[0m";
      const result = removeColorCodes(textWithColors);

      expect(result).toBe("Red text and Green text");
      expect(result).not.toContain("\u001b[31m");
      expect(result).not.toContain("\u001b[0m");
    });

    it("replaces ANSI codes with custom character when specified", () => {
      const textWithColors = "\u001b[31mRed\u001b[0m";
      const result = removeColorCodes(textWithColors, "*");

      expect(result).toBe("*Red*");
    });
  });

  describe("Section input parsing", () => {
    it("returns empty array when input is blank", () => {
      expect(parseEnabledSummarySections("")).toEqual([]);
    });

    it("accepts comma-separated tokens with aliases", () => {
      expect(parseEnabledSummarySections("new-tests, flaky")).toEqual(["new", "flaky"]);
    });

    it("accepts newline-separated tokens", () => {
      expect(parseEnabledSummarySections("retry\nflaky")).toEqual(["flaky", "retry"]);
    });

    it("expands 'all' to every supported section in canonical order", () => {
      expect(parseEnabledSummarySections("all")).toEqual(["new", "flaky", "retry"]);
    });

    it("ignores unknown tokens", () => {
      expect(parseEnabledSummarySections("new, bogus, retry")).toEqual(["new", "retry"]);
    });
  });

  describe("Quality gate format support", () => {
    it("treats empty array as passing", () => {
      expect(hasQualityGateFailures([])).toBe(false);
    });

    it("treats non-empty array as failing", () => {
      expect(hasQualityGateFailures([{ rule: "r", message: "m" } as any])).toBe(true);
    });

    it("treats env-keyed object with no failures as passing", () => {
      expect(hasQualityGateFailures({ prod: [], staging: [] } as any)).toBe(false);
    });

    it("treats env-keyed object with at least one failure as failing", () => {
      expect(
        hasQualityGateFailures({ prod: [], staging: [{ rule: "r", message: "m" } as any] }),
      ).toBe(true);
    });

    it("renders env-keyed body with environment labels and separators", () => {
      const body = formatQualityGateBody({
        prod: [{ rule: "Failed", message: "boom" } as any],
        staging: [{ rule: "Other", message: "ok" } as any],
      });
      expect(body).toContain('**Environment**: "prod"');
      expect(body).toContain('**Environment**: "staging"');
      expect(body).toContain("---");
    });
  });

  describe("Static remote href resolution", () => {
    it("returns summary remoteHref when no input override is provided", () => {
      expect(
        resolvePerSummaryRemoteHref({
          reportDir: "/reports",
          summaryFilePath: "/reports/a/summary.json",
          summaryRemoteHref: "https://hosted.example/a",
        }),
      ).toBe("https://hosted.example/a");
    });

    it("returns input remoteHref unchanged when no index.html exists in the summary directory", () => {
      (existsSync as unknown as Mock).mockReturnValue(false);
      expect(
        resolvePerSummaryRemoteHref({
          reportDir: "/reports",
          summaryFilePath: "/reports/a/summary.json",
          inputRemoteHref: "https://hosted.example/reports",
        }),
      ).toBe("https://hosted.example/reports");
    });

    it("appends summary dir suffix when index.html exists in a nested summary directory", () => {
      (existsSync as unknown as Mock).mockReturnValue(true);
      expect(
        resolvePerSummaryRemoteHref({
          reportDir: "/reports",
          summaryFilePath: "/reports/sub/dir/summary.json",
          inputRemoteHref: "https://hosted.example/reports/",
        }),
      ).toBe("https://hosted.example/reports/sub/dir");
    });
  });

  describe("Section comment assembly", () => {
    it("emits no comments when no sections are requested", () => {
      const summaries = [
        {
          summaryId: "report1/summary.json",
          name: "Suite",
          newTests: [{ id: "t1", name: "T1", status: "passed", duration: 1 } as any],
          flakyTests: [],
          retryTests: [],
        } as any,
      ];
      expect(assembleSectionComments(summaries, [])).toEqual([]);
    });

    it("emits a section comment per (section, summary) pair when tests exist", () => {
      const summaries = [
        {
          summaryId: "report1/summary.json",
          name: "Suite A",
          newTests: [{ id: "t1", name: "T1", status: "passed", duration: 1 } as any],
          flakyTests: [],
          retryTests: [{ id: "r1", name: "R1", status: "failed", duration: 2 } as any],
        } as any,
      ];
      const result = assembleSectionComments(summaries, ["new", "flaky", "retry"]);
      expect(result.map((c) => c.marker)).toEqual([
        buildSectionCommentMarker("report1/summary.json", "new"),
        buildSectionCommentMarker("report1/summary.json", "retry"),
      ]);
      expect(result[0].body).toContain("New Tests in Suite A");
      expect(result[1].body).toContain("Retry Tests in Suite A");
    });
  });
});
