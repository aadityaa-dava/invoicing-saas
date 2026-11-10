// Background workers are off in every e2e suite by default. Only the
// mail-queue suite turns its own worker on, so suites never race for jobs.
process.env.RUN_WORKERS = 'false';
