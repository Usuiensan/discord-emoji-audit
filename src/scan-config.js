function ids(value) {
  return [...new Set(value ?? [])].sort();
}

export function scanConfig(scan = {}) {
  return {
    scanDays: Number.isInteger(scan.scanDays) ? scan.scanDays : null,
    excludeBots: scan.excludeBots === true,
    excludedChannelIds: ids(scan.excludedChannelIds),
    onlyMe: scan.onlyMe === true,
    reportDays: Number.isInteger(scan.reportDays) ? scan.reportDays : 30,
    reportLimit: Number.isInteger(scan.reportLimit) ? scan.reportLimit : 10,
    scopeKey: scan.scopeKey ?? "all",
    rootChannelIds: ids(scan.rootChannelIds)
  };
}

export function scanResumeMatches(checkpointConfig, requestedScan) {
  return JSON.stringify(scanConfig(checkpointConfig)) === JSON.stringify(scanConfig(requestedScan));
}
