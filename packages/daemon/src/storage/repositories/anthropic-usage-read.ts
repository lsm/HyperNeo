import type { SDKRateLimitInfo } from '@hyperneo/shared/sdk';
import { defineDbOp } from '../db-gateway/db-op.ts';
import { sdkMessageBodyAt } from './sdk-message-body-read.ts';

const WINDOW_TYPES = new Set(['five_hour', 'seven_day', 'seven_day_opus', 'seven_day_sonnet']);

export const anthropicRateLimitEventsRead = defineDbOp<number, readonly SDKRateLimitInfo[]>({
  name: 'anthropic.rateLimitEvents',
  mode: 'read',
  run: (db, limit) => {
    const rows = db
      .prepare(
        `SELECT ${sdkMessageBodyAt('sdk_messages.rowid')} AS body FROM sdk_messages
          WHERE message_type = 'rate_limit_event'
          ORDER BY rowid DESC LIMIT ?`
      )
      .all(limit) as { body: string }[];
    const latest = new Map<string, SDKRateLimitInfo>();
    for (const row of rows) {
      let info: SDKRateLimitInfo | undefined;
      try {
        info = (JSON.parse(row.body) as { rate_limit_info?: SDKRateLimitInfo }).rate_limit_info;
      } catch {
        continue;
      }
      if (!info?.rateLimitType || !WINDOW_TYPES.has(info.rateLimitType)) continue;
      if (!latest.has(info.rateLimitType)) latest.set(info.rateLimitType, info);
    }
    const windows = ['five_hour', 'seven_day', 'seven_day_opus', 'seven_day_sonnet'];
    return [...latest.entries()]
      .sort((a, b) => windows.indexOf(a[0]) - windows.indexOf(b[0]))
      .map(([, info]) => info);
  },
});
