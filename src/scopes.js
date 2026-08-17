export function parseChannelIds(value) {
  const tokens = String(value ?? "").split(/[\s,]+/).filter(Boolean);
  const ids = [];
  for (const token of tokens) {
    const id = token.match(/^<?#?(\d+)>?$/)?.[1];
    if (!id) throw new Error(`チャンネル指定が不正です: ${token}`);
    ids.push(id);
  }
  return [...new Set(ids)].sort();
}

export function channelScopeKey(rootChannelIds = []) {
  return rootChannelIds.length ? `channels:${[...new Set(rootChannelIds)].sort().join(",")}` : "all";
}

export function channelMatchesScope(channel, rootChannelIds = [], channelIds = []) {
  if (!rootChannelIds.length) return true;
  return rootChannelIds.includes(channel?.id)
    || rootChannelIds.includes(channel?.parentId)
    || channelIds.includes(channel?.id);
}
