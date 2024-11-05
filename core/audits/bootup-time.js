import log from 'lighthouse-logger';
import { Audit } from './audit.js';
import { taskGroups } from '../lib/tracehouse/task-groups.js';
import * as i18n from '../lib/i18n/i18n.js';
import { NetworkRecords } from '../computed/network-records.js';
import { MainThreadTasks } from '../computed/main-thread-tasks.js';
import { getExecutionTimingsByURL } from '../lib/tracehouse/task-summary.js';
import { TBTImpactTasks } from '../computed/tbt-impact-tasks.js';
import { Sentry } from '../lib/sentry.js';
import { Util } from '../../shared/util.js';

const UIStrings = {
  title: 'JavaScript execution time',
  failureTitle: 'Reduce JavaScript execution time',
  description: 'Consider reducing the time spent parsing, compiling, and executing JS. You may find delivering smaller JS payloads helps with this. [Learn how to reduce Javascript execution time](https://developer.chrome.com/docs/lighthouse/performance/bootup-time/).',
  columnTotal: 'Total CPU Time',
  columnScriptEval: 'Script Evaluation',
  columnScriptParse: 'Script Parse',
  chromeExtensionsWarning: 'Chrome extensions negatively affected this page\'s load performance. Try auditing the page in incognito mode or from a Chrome profile without extensions.',
};

const str_ = i18n.createIcuMessageFn(import.meta.url, UIStrings);

class BootupTime extends Audit {
  static get meta() {
    return {
      id: 'bootup-time',
      title: str_(UIStrings.title),
      failureTitle: str_(UIStrings.failureTitle),
      description: str_(UIStrings.description),
      scoreDisplayMode: Audit.SCORING_MODES.METRIC_SAVINGS,
      guidanceLevel: 1,
      requiredArtifacts: ['traces', 'devtoolsLogs', 'URL', 'GatherContext'],
    };
  }

  static get defaultOptions() {
    return {
      p10: 1282,
      median: 3500,
      thresholdInMs: 50,
    };
  }

  static async getTbtImpact(artifacts, context) {
    let tbtImpact = 0;
    try {
      const metricComputationData = Audit.makeMetricComputationDataInput(artifacts, context);
      const tasks = await TBTImpactTasks.request(metricComputationData, context);

      // Process tasks in a more efficient manner, reducing redundant checks
      tbtImpact = tasks.reduce((impact, task) => {
        const groupId = task.group.id;
        if (groupId === 'scriptEvaluation' || groupId === 'scriptParseCompile') {
          return impact + task.selfTbtImpact;
        }
        return impact;
      }, 0);
    } catch (err) {
      Sentry.captureException(err, { tags: { audit: this.meta.id }, level: 'error' });
      log.error(this.meta.id, err.message);
    }
    return tbtImpact;
  }

  static async audit(artifacts, context) {
    const settings = context.settings || {};
    const trace = artifacts.traces[BootupTime.DEFAULT_PASS];
    const devtoolsLog = artifacts.devtoolsLogs[BootupTime.DEFAULT_PASS];
    const networkRecords = await NetworkRecords.request(devtoolsLog, context);
    const tasks = await MainThreadTasks.request(trace, context);
    const multiplier = settings.throttlingMethod === 'simulate' ? settings.throttling.cpuSlowdownMultiplier : 1;

    // Gather execution timings and filter out the unnecessary ones early
    const executionTimings = getExecutionTimingsByURL(tasks, networkRecords);
    executionTimings.delete('_lighthouse-eval.js');  // Skip lighthouse own tasks early

    const tbtImpact = await this.getTbtImpact(artifacts, context);

    let hadExcessiveChromeExtension = false;
    let totalBootupTime = 0;

    // Using a more efficient map and reducing intermediate array creation
    const results = Array.from(executionTimings).map(([url, timingByGroupId]) => {
      let totalExecutionTimeForURL = 0;
      let scriptingTotal = 0;
      let parseCompileTotal = 0;

      for (const [groupId, timespanMs] of Object.entries(timingByGroupId)) {
        timingByGroupId[groupId] = timespanMs * multiplier;
        totalExecutionTimeForURL += timespanMs * multiplier;

        if (groupId === taskGroups.scriptEvaluation.id) {
          scriptingTotal = timespanMs * multiplier;
        } else if (groupId === taskGroups.scriptParseCompile.id) {
          parseCompileTotal = timespanMs * multiplier;
        }
      }

      // Add the totals for JavaScript execution
      if (totalExecutionTimeForURL >= context.options.thresholdInMs) {
        totalBootupTime += scriptingTotal + parseCompileTotal;
      }

      // Track excessive Chrome extension impact
      if (url.startsWith('chrome-extension:') && scriptingTotal > 100) {
        hadExcessiveChromeExtension = true;
      }

      return {
        url,
        total: totalExecutionTimeForURL,
        scripting: scriptingTotal,
        scriptParseCompile: parseCompileTotal,
      };
    }).filter(result => result.total >= context.options.thresholdInMs)
      .sort((a, b) => b.total - a.total); // Sorting by total execution time

    // Handle Chrome extension warnings separately to avoid redundant calculations
    const runWarnings = hadExcessiveChromeExtension ? [str_(UIStrings.chromeExtensionsWarning)] : undefined;

    const headings = [
      { key: 'url', valueType: 'url', label: str_(i18n.UIStrings.columnURL) },
      { key: 'total', granularity: 1, valueType: 'ms', label: str_(UIStrings.columnTotal) },
      { key: 'scripting', granularity: 1, valueType: 'ms', label: str_(UIStrings.columnScriptEval) },
      { key: 'scriptParseCompile', granularity: 1, valueType: 'ms', label: str_(UIStrings.columnScriptParse) },
    ];

    const details = BootupTime.makeTableDetails(headings, results, {
      wastedMs: totalBootupTime,
      sortedBy: ['total'],
    });

    const score = Audit.computeLogNormalScore(
      { p10: context.options.p10, median: context.options.median },
      totalBootupTime
    );

    return {
      score,
      scoreDisplayMode: score >= Util.PASS_THRESHOLD ? Audit.SCORING_MODES.INFORMATIVE : undefined,
      notApplicable: !results.length,
      numericValue: totalBootupTime,
      numericUnit: 'millisecond',
      displayValue: totalBootupTime > 0 ? str_(i18n.UIStrings.seconds, { timeInMs: totalBootupTime }) : '',
      details,
      runWarnings,
      metricSavings: {
        TBT: tbtImpact,
      },
    };
  }
}

export default BootupTime;
export { UIStrings };
