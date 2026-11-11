export const JOBS_QUEUE = Symbol('JOBS_QUEUE');
export const JOBS_QUEUE_NAME = 'jobs';

export const OVERDUE_SWEEP = 'overdue-sweep';
export const OVERDUE_ORG = 'overdue-org';
export const RECURRING_SWEEP = 'recurring-sweep';
export const RECURRING_ORG = 'recurring-org';

// Ids are fixed so registering them again updates in place instead of
// duplicating. Cron runs in UTC.
export const SCHEDULES = [
  { id: 'overdue-sweep-daily', pattern: '15 2 * * *', job: OVERDUE_SWEEP },
  { id: 'recurring-sweep-daily', pattern: '30 2 * * *', job: RECURRING_SWEEP },
] as const;

// Sweeps carry no data (the date is fixed when they run). Per-org jobs carry
// ids and the date only: never invoice content.
export type JobData = { asOf?: string; orgId?: string };
