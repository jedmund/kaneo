import { Cron } from "croner";
import { retryScmSyncJobs } from "../plugins/registry";
import { checkDueDateReminders } from "./due-date-reminders";
import { checkProjectWebhookReminders } from "./project-webhook-reminders";
import { reconcileWorkspaceSeats } from "./seat-reconciliation";

const jobs: Cron[] = [];

export function initializeScheduler(): void {
  jobs.push(new Cron("*/5 * * * *", checkDueDateReminders));
  jobs.push(new Cron("*/5 * * * *", checkProjectWebhookReminders));
  jobs.push(new Cron("17 * * * *", reconcileWorkspaceSeats));
  jobs.push(new Cron("* * * * *", retryScmSyncJobs));
  console.log(
    "⏰ Scheduler started (reminders every 5 minutes, SCM retries every minute, seat reconciliation hourly)",
  );
}

export function shutdownScheduler(): void {
  for (const job of jobs) {
    job.stop();
  }
  jobs.length = 0;
}
