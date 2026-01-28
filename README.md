# Allure Report Action

A GitHub Action that integrates Allure Report 3 directly into your pull request workflow by posting comprehensive test summaries as comments.

## Features

This action automatically analyzes your Allure Report data and creates rich PR comments containing:

- **Test Statistics**: Complete breakdown of test results including passed, failed, broken, skipped, and unknown tests
- **Visual Indicators**: Pie charts and status icons for quick visual assessment
- **Special Test Categories**: Identification of new tests, flaky tests, and retry attempts
- **Remote Report Integration**: Automatic linking to Allure Service hosted reports when configured
- **Quality Gate Validation**: Creates GitHub check runs based on quality gate results

## Quick Start

### Prerequisites

Ensure your workflow has the necessary permissions:

```yaml
permissions:
  pull-requests: write
  checks: write
```

### Basic Setup

Add this action to your workflow after your test execution step:

```yaml
- name: Execute test suite
  run: |
    # Your test commands that generate Allure Report data

- name: Post Allure Report Summary
  uses: your-username/allure-report-action@v1
  with:
    report-directory: "./allure-report"
    github-token: ${{ secrets.GITHUB_TOKEN }}
```

## Configuration Options

### Inputs

| Input | Description | Required | Default |
|-------|-------------|----------|---------|
| `report-directory` | Directory path containing Allure Report data | No | `./allure-report` |
| `github-token` | GitHub token for PR comment operations | No | `${{ github.token }}` |

### Allure Configuration

This action reads configuration from your `allurerc.js` or `allurerc.mjs` file. The `output` field specifies where to look for generated reports.

#### Example Configuration

```javascript
import { defineConfig } from "allure";

export default defineConfig({
  output: "allure-report",
});
```

### Remote Report Integration

To enable automatic linking to reports hosted on Allure Service, add the `allureService` configuration:

```javascript
import { defineConfig } from "allure";
import { env } from "node:process";

export default defineConfig({
  output: "allure-report",
  allureService: {
    url: env.ALLURE_SERVICE_URL,
    project: env.ALLURE_SERVICE_PROJECT,
    accessToken: env.ALLURE_SERVICE_ACCESS_TOKEN,
  }
});
```

## Example Workflow

```yaml
name: Test Suite with Allure Report

on:
  pull_request:
    branches: [ main ]

permissions:
  pull-requests: write
  checks: write

jobs:
  test:
    runs-on: ubuntu-latest

    steps:
      - uses: actions/checkout@v4

      - name: Setup test environment
        run: |
          # Setup commands

      - name: Run tests
        run: |
          # Test execution that generates Allure data

      - name: Generate Allure Report
        run: |
          # Generate report command

      - name: Post Allure Summary
        uses: your-username/allure-report-action@v1
        with:
          report-directory: "./allure-report"
          github-token: ${{ secrets.GITHUB_TOKEN }}
```

## How It Works

1. **Scans Report Directory**: The action searches for `summary.json` files in the specified directory
2. **Parses Test Data**: Reads and processes all discovered summary files
3. **Quality Gate Check**: If `quality-gate.json` exists, creates a GitHub check run with validation results
4. **Creates PR Comment**: Generates a markdown table with test statistics and posts it to the pull request
5. **Updates Existing Comments**: Uses a unique marker to update existing comments instead of creating duplicates

## Output Example

The action creates a comment in your pull request similar to this:

| | Name | Duration | Stats | New | Flaky | Retry | Report |
|-|-|-|-|-|-|-|-|
| 🥧 | Test Suite | 2m 30s | ✅ 45  ❌ 2  ⚠️ 1  ⏭️ 3 | 5 | 2 | 1 | View |

## Development

### Building

```bash
npm install
npm run build
```

### Testing

```bash
npm test
```

### Local Testing

```bash
npm run dev
```

## License

MIT License - See [LICENSE](LICENSE) file for details

## Resources

- [Allure Report Documentation](https://allurereport.org/docs/)
- [GitHub Actions Documentation](https://docs.github.com/en/actions)
